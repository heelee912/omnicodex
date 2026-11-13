import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CallToolResult,
  ListToolsResult,
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type CallToolResult as ModernCallToolResult,
  type ListToolsResult as ModernListToolsResult,
  ResourceNotFoundError,
  Server,
} from "@modelcontextprotocol/server";
import {
  type AppServerMethodCatalog,
  AppServerMethodExecutor,
} from "../../application/app-server-method-catalog.js";
import {
  type BrowserNativeCallContext,
  type BrowserNativeExecutionStage,
  type BrowserNativeExecutor,
  classifyBrowserNativeOperation,
  isCuaNativeTool,
} from "../../application/browser-native-executor.js";
import type {
  BrowserActivityLifecycleCoordinator,
  BrowserActivityLifecycleExecutor,
} from "../../application/chatgpt-browser-activity-coordinator.js";
import { codeModeBrowserNativeTools } from "../../application/code-mode-native-tool-surface.js";
import {
  type CodexAppHostToolCatalogSnapshot,
  type CodexAppHostToolDescriptor,
  CodexAppHostToolExecutor,
} from "../../application/codex-app-host-tool-executor.js";
import type { CodexThreadMessageClient } from "../../application/codex-thread-message-client.js";
import { ComputerUseNativeResponseError } from "../../application/computer-use-native-executor.js";
import {
  mergeNativeExecutionOrdering,
  type NativeExecutionOrdering,
  NativeExecutionScheduler,
  nativeExecutionOrderingFromArguments,
  resolveNativeExecutionTimeout,
} from "../../application/native-execution-scheduler.js";
import { omitBlankOptionalNativeSettingOverrides } from "../../application/native-tool-argument-normalizer.js";
import {
  type AppServerRpcClient,
  isModelInvokingAppServerMethod,
  NativeToolCatalog,
  NativeToolExecutor,
  type NativeToolProgressEvent,
} from "../../application/native-tool-catalog.js";
import {
  presentedNativeToolDescription,
  presentedNativeToolInputSchema,
  presentedNativeToolMetadata,
  splitNativeIdentity,
} from "../../application/native-tool-presentation.js";
import {
  buildNativeToolRegistry,
  type NativeToolRegistryEntry,
  type NativeToolRegistrySnapshot,
  publicNativeToolAnnotations,
} from "../../application/native-tool-registry.js";
import { withOmniCodexServerIdentity } from "../../application/native-tool-server-identity.js";
import type {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "../../application/responses-native-tool-catalog.js";
import { normalizeChatGptConversationUrl } from "../chatgpt/chatgpt-conversation-route.js";
import type { DurableNativeResourceLeaseCoordinatorLike } from "../runtime/durable-native-resource-lease-coordinator.js";
import { JsonlRpcError } from "../runtime/jsonl-rpc-client.js";
import { structuredErrorDetails } from "../runtime/structured-error-details.js";
import {
  abortDirectGoalExecutionBeforeDispatch,
  beginDirectGoalExecution,
  callDirectGoalTool,
  DIRECT_GOAL_CONTEXT_FIELD,
  type DirectGoalExecutionAuthorization,
  type DirectGoalInvocationContext,
  directGoalOwnerBinding,
  directGoalResourceDigest,
  directGoalTools,
  finalizeDirectGoalExecution,
  isDirectGoalTool,
  markDirectGoalExecutionDispatched,
  markDirectGoalExecutionOutcomeUnknown,
  splitDirectGoalContext,
} from "./direct-goal-mcp-tools.js";
import type {
  DirectGoalStore,
  DirectGoalUnknownExecutionReadbackContext,
} from "./direct-goal-store.js";
import {
  callDirectJobTool,
  type DirectJobDispatchAdapter,
  type DirectJobDispatchOutcome,
  type DirectJobInvocationContext,
  type DirectJobManager,
  directJobTools,
  isDirectJobTool,
} from "./direct-job-mcp-tools.js";
import type { DirectJobTargetContract } from "./direct-job-store.js";
import {
  callDirectScheduleTool,
  type DirectScheduleInvocationContext,
  type DirectScheduleManager,
  directScheduleTools,
  isDirectScheduleTool,
} from "./direct-schedule-mcp-tools.js";
import type { DurableWorkSessionBinding } from "./durable-work-session-store.js";
import {
  type LegacyMutationAcquisition,
  LegacyMutationAmbiguityError,
  type LegacyMutationCoordinator,
  type LegacyMutationExecution,
  type LegacyMutationTerminal,
} from "./legacy-mutation-coordinator.js";
import {
  LEGACY_MUTATION_STATUS_TOOL,
  legacyMutationStatusTool,
  readLegacyMutationStatus,
} from "./legacy-mutation-status-tool.js";
import type {
  McpRequestAttribution,
  McpRequestIdentityDigest,
} from "./mcp-work-session-context.js";
import type {
  MutationReplayAcquisition,
  MutationReplayJsonValue,
  MutationReplayStore,
  MutationReplayTerminal,
} from "./mutation-replay-store.js";
import {
  PROTECTED_RESULT_READ_TOOL,
  withProtectedResultInlineControl,
} from "./protected-result-mapper.js";
import {
  type ReadInvocationAcquisition,
  ReadInvocationConflictError,
  ReadInvocationCoordinator,
  type ReadInvocationJsonValue,
  readInvocationSemanticArguments,
} from "./read-invocation-coordinator.js";
export type BrowserNativeToolExecutor = Pick<BrowserNativeExecutor, "call"> &
  Partial<
    Pick<
      BrowserNativeExecutor,
      "callCua" | "beginActivity" | "finishActivity" | "finishCurrentActivity"
    >
  >;

interface BrowserActivityStopOutcome {
  execution?: LegacyMutationExecution<null>;
  cleanupSucceeded?: boolean;
}

export const OMNICODEX_MCP_SERVER_NAME = "OmniCodex";
export const OMNICODEX_ACTIVITY_RESOURCE_URI = "ui://omnicodex/activity/v1.html";
const OMNICODEX_ACTIVITY_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const OMNICODEX_ACTIVITY_RESOURCE_HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; padding: 8px 10px; background: transparent; color: inherit; }
    #activity { display: flex; min-width: 0; align-items: center; gap: 8px; font-size: 13px; line-height: 1.35; }
    #mark { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: #10a37f; }
    #mark[data-state="error"] { background: #ef4444; }
    #mark[data-state="unknown"] { background: #888; }
    #mark[data-state="running"] { background: #f59e0b; animation: pulse 1.1s ease-in-out infinite; }
    #name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    #status { flex: 0 0 auto; opacity: .7; white-space: nowrap; }
    @keyframes pulse { 50% { opacity: .35; } }
    @media (max-width: 420px) { body { padding: 6px 8px; } #activity { font-size: 12px; gap: 6px; } }
    @media (prefers-reduced-motion: reduce) { #mark { animation: none !important; } }
  </style>
</head>
<body>
  <div id="activity" role="status" aria-live="polite">
    <span id="mark" data-state="unknown"></span>
    <span id="name">OmniCodex</span>
    <span id="status">결과 미확인</span>
  </div>
  <script>
    (() => {
      const mark = document.getElementById("mark");
      const name = document.getElementById("name");
      const status = document.getElementById("status");
      let notificationResult;
      let notifiedGlobals = {};

      const object = (value) => value && typeof value === "object" ? value : {};
      const globals = () => ({ ...object(window.openai), ...notifiedGlobals });
      const envelope = () => {
        const host = globals();
        const responseMetadata = object(host.toolResponseMetadata);
        return object(
          notificationResult ??
          responseMetadata.mcp_tool_result ??
          responseMetadata.call_tool_result ??
          (host.toolOutput == null ? undefined : { structuredContent: host.toolOutput })
        );
      };
      const render = () => {
        const result = envelope();
        const resultMeta = object(result._meta);
        // A standard tool-result notification is a complete envelope. Do not
        // combine it with a stale compatibility-channel status or activity.
        const hostMetadata = notificationResult === undefined
          ? object(globals().toolResponseMetadata)
          : {};
        const activity = object(resultMeta["omnicodex/activity"] ?? hostMetadata["omnicodex/activity"]);
        const hostStatus = typeof hostMetadata.status === "string" ? hostMetadata.status : "";
        const failed = result.isError === true || activity.state === "error" || hostStatus === "failed";
        const running = !failed && (activity.state === "running" || hostStatus === "in_progress");
        const completed = activity.state === "completed" || hostStatus === "completed" ||
          Array.isArray(result.content) || result.structuredContent !== undefined;
        const state = failed ? "error" : running ? "running" : completed ? "completed" : "unknown";
        const toolName = typeof activity.toolName === "string" && activity.toolName.length > 0
          ? activity.toolName.replaceAll("__", " / ")
          : "OmniCodex";
        const duration = Number.isSafeInteger(activity.durationMs) && activity.durationMs >= 0
          ? " · " + (activity.durationMs < 1000
              ? String(activity.durationMs) + "ms"
              : (activity.durationMs / 1000).toFixed(1) + "s")
          : "";
        const statusText = (failed ? "오류" : running ? "실행 중" : completed ? "완료" : "결과 미확인") + duration;
        if (mark.dataset.state !== state) mark.dataset.state = state;
        if (name.textContent !== toolName) name.textContent = toolName;
        if (status.textContent !== statusText) status.textContent = statusText;
      };

      window.addEventListener("openai:set_globals", (event) => {
        // Some hosts publish the update in the event before updating window.openai.
        const update = object(event?.detail?.globals);
        if (Object.hasOwn(update, "toolOutput") || Object.hasOwn(update, "toolResponseMetadata")) {
          notificationResult = undefined;
        }
        notifiedGlobals = { ...notifiedGlobals, ...update };
        render();
      }, { passive: true });
      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = object(event.data);
        if (message.jsonrpc !== "2.0" || message.method !== "ui/notifications/tool-result") return;
        notificationResult = object(message.params);
        render();
      }, { passive: true });
      render();
    })();
  </script>
</body>
</html>`;
export interface ProtectedResultReadRequest {
  readonly resourceId: string;
  readonly offset: number;
  readonly expectedDigest?: string;
}

export interface ProtectedResultReadChunk {
  readonly schemaVersion: 1;
  readonly resourceId: string;
  readonly mimeType: string;
  readonly digest: string;
  readonly digestAlgorithm: "sha-256";
  readonly byteLength: number;
  readonly offset: number;
  readonly endOffset: number;
  readonly nextOffset: number | null;
  readonly chunk: string;
  readonly snapshotIntegrity?: "verified";
  readonly deliveryState?: "partial" | "end_of_snapshot";
}

export interface OmniCodexMcpServerOptions {
  readonly appServer: AppServerRpcClient;
  readonly nativeToolRegistryCatalog?: OmniCodexNativeToolRegistryCatalog;
  readonly appServerMethodCatalog?: AppServerMethodCatalog;
  readonly appServerMethodExecutor?: AppServerMethodExecutor;
  readonly nativeToolCatalog?: NativeToolCatalog;
  readonly nativeToolExecutor?: NativeToolExecutor;
  readonly responsesToolCatalog?: ResponsesNativeToolCatalog;
  readonly responsesToolExecutor?: ResponsesNativeToolExecutor;
  readonly browserNativeExecutor?: BrowserNativeToolExecutor;
  /** Runtime-wide native turn lifecycle shared by every Web conversation. */
  readonly browserActivityCoordinator?: BrowserActivityLifecycleCoordinator;
  readonly codexAppHostToolExecutor?: CodexAppHostToolExecutor;
  readonly desktopIpcClient?: CodexThreadMessageClient;
  readonly scheduler?: NativeExecutionScheduler;
  readonly serverVersion?: string;
  /** Stable identity of the public OmniCodex deployment advertising these tools. */
  readonly serverIdentity?: string;
  readonly surface?: "compat" | "full";
  /**
   * Conservative UTF-8 budget for a ChatGPT action catalog's token-bearing
   * name, description, and input schema. Omitted keeps the complete paginated
   * descriptor catalog. Tools outside this registration view remain losslessly
   * discoverable and executable through search_native_tools/call_native_tool.
   */
  readonly actionCatalogByteBudget?: number;
  /** Internal unconnected handle whose only consumer is the runtime schedule dispatcher. */
  readonly runtimeDispatchOnly?: boolean;
  /** Opaque per-MCP-session value; never the MCP session id itself. */
  readonly correlationId?: string;
  /** Stable owner boundary shared by every MCP session for the same authorized caller. */
  readonly authorizationBinding?: string;
  /** Gateway-wide durable direct-work Goal and server-observed evidence store. */
  readonly directGoalStore?: DirectGoalStore;
  /** Daemon-wide durable native fence reconciled only after a successful Goal readback. */
  readonly nativeResourceLeaseCoordinator?: DurableNativeResourceLeaseCoordinatorLike;
  /** Gateway-wide durable native direct-job coordinator. */
  readonly directJobManager?: DirectJobManager;
  /** Runtime-generation exact-native durable schedule coordinator. */
  readonly directScheduleManager?: DirectScheduleManager;
  /** Runtime-owned model-free dispatcher used by jobs and schedules. */
  readonly directJobDispatchAdapter?: DirectJobDispatchAdapter;
  /** Resolves the current server-owned work binding after request metadata has been observed. */
  readonly resolveDurableWorkSessionBinding?: () =>
    | Promise<DirectJobWorkSessionBinding>
    | DirectJobWorkSessionBinding;
  /** Gateway-resolved work sessions belonging to the authenticated principal. */
  readonly listAuthorizedGoalWorkSessionBindings?: () => Promise<readonly string[]>;
  /** Gateway-wide, restart-durable mutation coordinator. */
  readonly mutationReplayStore?: MutationReplayStore;
  /** Gateway-wide, restart-durable fan-out coordinator for cached legacy schemas. */
  readonly legacyMutationCoordinator?: LegacyMutationCoordinator;
  /** Runtime-generation-wide fan-in and short replay for explicit native reads. */
  readonly readInvocationCoordinator?: ReadInvocationCoordinator;
  /** Exact request-local transport identity captured by the HTTP gateway. */
  readonly resolveRequestAttribution?: (
    requestId?: string | number,
  ) => McpRequestAttribution | undefined;
  readonly protectResult?: (
    result: CallToolResult,
    context: {
      readonly sessionId?: string;
      readonly workSession?: Pick<
        DirectJobWorkSessionBinding,
        "workSessionBinding" | "continuationToken"
      >;
    },
  ) => Promise<CallToolResult> | CallToolResult;
  readonly readProtectedResult?: (
    request: ProtectedResultReadRequest,
  ) => Promise<ProtectedResultReadChunk> | ProtectedResultReadChunk;
  /** Read a previously issued resource link under the authenticated owner's identity. */
  readonly readLinkedResource?: (uri: string) => Promise<ReadResourceResult | undefined>;
  readonly materializeLocalFile?: (
    path: string,
    context: {
      readonly sessionId?: string;
      readonly workSession?: Pick<
        DirectJobWorkSessionBinding,
        "workSessionBinding" | "continuationToken"
      >;
    },
  ) => Promise<CallToolResult> | CallToolResult;
  /**
   * Request-local orchestration started before a materializable file result is
   * returned. It must never hold the MCP response open. The exact conversation
   * URL must never be persisted or copied into telemetry observations.
   */
  readonly prepareProtectedResultDelivery?: (input: {
    readonly surface: "compat" | "full";
    readonly mcpToolName: string;
    readonly chatGptConversationUrl?: string;
    readonly correlationId?: string;
  }) => Promise<void> | void;
  /** Metadata-only execution observer. Tool arguments and results are never included. */
  readonly observeNativeToolExecution?: (
    observation: NativeToolExecutionObservation,
  ) => Promise<void> | void;
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
  /** Privacy-safe proof of the exact tool catalog page returned to an MCP client. */
  readonly observeToolCatalog?: (observation: McpToolCatalogObservation) => Promise<void> | void;
}

export type DirectJobWorkSessionBinding = Pick<
  DurableWorkSessionBinding,
  | "workSessionBinding"
  | "directGoalClaimantBinding"
  | "directJobOwnerBinding"
  | "continuationToken"
  | "journalCursor"
>;

export interface McpRequestAttributionObservation {
  readonly correlationId?: string;
  /** Stable authenticated account/tenant/resource digest. Never a raw bearer claim. */
  readonly principalBindingSha256?: string;
  /** Authenticated transport provenance; never inferred from tool text or arguments. */
  readonly callerProvenance?: McpRequestAttribution["callerProvenance"];
  /** Stable digest of the caller-supplied native invocation identity. */
  readonly invocationIdSha256?: string;
  /** Process-keyed HMAC of the exact JSON-RPC request id. */
  readonly jsonRpcIdHmac?: string;
  /** Allowlisted request/session/correlation/idempotency identities as keyed HMACs. */
  readonly transportIdentityDigests?: readonly McpRequestIdentityDigest[];
  /** SHA-256 of the validated ChatGPT conversation id; never the raw route. */
  readonly chatGptConversationIdSha256?: string;
  /** Stable server-issued Web-conversation binding digest. */
  readonly workSessionBindingSha256?: string;
}

export interface McpToolCatalogObservation extends McpRequestAttributionObservation {
  readonly surface: "compat" | "full";
  readonly catalogRevision: string;
  readonly cursorPresent: boolean;
  /** Whether this response advertises another page. Page boundaries are transport-specific. */
  readonly nextCursorPresent: boolean;
  readonly toolCount: number;
  readonly criticalToolCount: number;
  readonly criticalToolProperties?: string;
  readonly criticalToolRequired?: string;
  readonly criticalToolDescriptionSha256?: string;
  readonly criticalToolInputSchemaSha256?: string;
}

/**
 * Privacy-safe, process-local readback of the exact full tool catalog that the
 * running gateway would advertise to a newly initialized MCP client.
 */
export interface OmniCodexFullCatalogSnapshot {
  readonly catalogRevision: string;
  readonly catalogToolCount: number;
  readonly catalogPageToolCounts: readonly number[];
  /** Canonically sorted, exact public tool-name set advertised by `/mcp/full`. */
  readonly catalogToolNames: readonly string[];
  /** Stable digest of `catalogToolNames`, used for compact persisted evidence. */
  readonly catalogToolNamesSha256: string;
  /** Digest of private routing identities retained outside the public action surface. */
  readonly catalogIdentitySha256: string;
  readonly modelToolCount: number;
  readonly unknownModelEffectCount: number;
  /** Present only when this runtime generation advertises native functions.exec. */
  readonly criticalToolProperties?: string;
  readonly criticalToolRequired?: string;
  readonly criticalToolDescriptionSha256?: string;
  readonly criticalToolInputSchemaSha256?: string;
  /** Exact bounded action set that ChatGPT registers eagerly for this same revision. */
  readonly chatGptActionToolCount: number;
  readonly chatGptActionToolNames: readonly string[];
  readonly chatGptActionToolNamesSha256: string;
  /** Privacy-safe per-action contract hashes for convergence diagnostics. */
  readonly chatGptActionContractItems?: readonly {
    readonly name: string;
    readonly sha256: string;
  }[];
  /**
   * Digest of the complete eager ChatGPT action definitions, excluding only
   * the volatile native-registry revision embedded in OmniCodex metadata.
   * Names alone cannot detect stale schemas, descriptions, annotations, or
   * other model-facing MCP fields retained by ChatGPT's frozen snapshot.
   */
  readonly chatGptActionContractSha256: string;
  readonly chatGptCriticalToolName: string;
  readonly chatGptCriticalToolProperties: string;
  readonly chatGptCriticalToolRequired: string;
  readonly chatGptCriticalToolDescriptionSha256: string;
  readonly chatGptCriticalToolInputSchemaSha256: string;
}

export interface OmniCodexFullCatalogSnapshotOptions {
  readonly appServer: AppServerRpcClient;
  readonly serverIdentity?: string;
  readonly appServerMethodCatalog?: AppServerMethodCatalog;
  readonly responsesToolCatalog?: ResponsesNativeToolCatalog;
  readonly browserNativeExecutor?: BrowserNativeToolExecutor;
  readonly codexAppHostToolExecutor: CodexAppHostToolExecutor;
  readonly directGoalStore?: DirectGoalStore;
  readonly directJobManager?: DirectJobManager;
  readonly directScheduleManager?: DirectScheduleManager;
  readonly mutationReplayStore?: MutationReplayStore;
  readonly nativeToolCatalog?: NativeToolCatalog;
  /** Must match the public ChatGPT gateway's eager action-registration budget. */
  readonly actionCatalogByteBudget?: number;
}

export interface NativeToolExecutionObservation extends McpRequestAttributionObservation {
  /** SHA-256 of the caller-supplied cross-transport invocation identity; never the raw value. */
  readonly invocationIdSha256?: string;
  readonly workSessionBindingSha256?: string;
  /** SHA-256 correlation key for the exact native resource; never raw arguments or results. */
  readonly resourceDigestSha256?: string;
  readonly surface: "compat" | "full";
  readonly mcpToolName: string;
  readonly operation: "search" | "native_call" | "app_server_rpc";
  readonly targetToolId?: string;
  readonly targetNativeName?: string;
  readonly targetNamespace?: string;
  readonly targetRoute?:
    | NativeToolRegistryEntry["route"]
    | "app_server_rpc"
    | "browser_native"
    | "codex_app_native"
    | "computer_use_native"
    | "desktop_ipc"
    | "mcp_control";
  readonly modelEffect?: NativeToolRegistryEntry["modelEffect"];
  readonly stateEffect?: NativeToolRegistryEntry["stateEffect"];
  /** Digest of the exact native argument value; raw arguments are never logged. */
  readonly requestArgumentsSha256?: string;
  /** Privacy-safe target/message provenance for explicit native thread transmissions. */
  readonly targetThreadIdSha256?: string;
  readonly messagePromptSha256?: string;
  readonly messageTransmissionRequested?: boolean;
  /** Whether the caller omitted, blanked, or explicitly selected a setting override. */
  readonly modelOverride?: NativeSettingOverridePresence;
  readonly reasoningOverride?: NativeSettingOverridePresence;
  /** Privacy-safe failure identity; raw native error text is returned to the caller, not logged. */
  readonly errorClass?: NativeExecutionErrorClass;
  readonly errorName?: string;
  readonly errorCode?: string;
  readonly errorDetailsSha256?: string;
  readonly modelUsage?: number;
  readonly resultContentTypes?: string;
  /**
   * SHA-256 commitment to the complete native CallToolResult. The result is
   * still returned losslessly to the caller; only this privacy-safe digest is
   * persisted so request and authoritative readback can be correlated.
   */
  readonly resultSha256?: string;
  /** Last trusted executor boundary reached, independent of the success/error outcome. */
  readonly browserExecutionStage?: BrowserNativeExecutionStage;
  /** The Node REPL envelope does not expose the function-body return value reliably. */
  readonly browserReturnValuePresence?: "unknown";
  /** Exact fixed codes only; arbitrary native error codes remain outside this field. */
  readonly browserDiagnosticErrorCode?: BrowserDiagnosticErrorCode;
  readonly outcome: "succeeded" | "tool_error" | "failed";
}

const BROWSER_DIAGNOSTIC_ERROR_CODES = [
  "BROWSER_SURFACE_UNAVAILABLE",
  "BROWSER_SELECTION_STALE",
  "BROWSER_OUTCOME_UNKNOWN_REBOUND",
  "BROWSER_OUTCOME_UNKNOWN_RECOVERY_FAILED",
  "BROWSER_RECOVERY_FAILED",
  "AMBIGUOUS_LEGACY_MUTATION_COHORT",
] as const;
type BrowserDiagnosticErrorCode = (typeof BROWSER_DIAGNOSTIC_ERROR_CODES)[number];

export type NativeSettingOverridePresence = "omitted" | "blank" | "explicit";

export type NativeExecutionErrorClass =
  | "timeout"
  | "unavailable"
  | "disconnected"
  | "permission_denied"
  | "invalid_request"
  | "unknown_tool"
  | "outcome_unknown"
  | "native_error";

export interface McpProgressObservation extends McpRequestAttributionObservation {
  readonly invocationIdentityInputs?: MutationIdentityInputPresence;
  readonly surface: "compat" | "full";
  readonly mcpToolName: string;
  /** Commitment to the received MCP arguments before routing or native dispatch. */
  readonly mcpArgumentsSha256?: string;
  readonly phase: "started" | "native" | "completed";
  readonly requested: boolean;
  readonly emitted: boolean;
}

export interface McpResultDeliveryObservation extends McpRequestAttributionObservation {
  readonly surface: "compat" | "full";
  readonly mcpToolName: string;
  readonly contentTypes: string;
  readonly protectedResourceLinks: number;
  /** Owner-protected receipt locator only; never includes retrieval credentials or payload. */
  readonly protectedErrorResourceId?: string;
  readonly protectedErrorDigest?: string;
  /** UTF-8 bytes in the exact CallToolResult handed to the MCP transport. */
  readonly deliveredByteLength: number;
  /** True when only the automatic Browser Use UI preview was detached losslessly. */
  readonly nativeBrowserPreviewDetached: boolean;
  /** Exact request-local approval route. Observers must not persist or log it. */
  readonly chatGptConversationUrl?: string;
  /** An explicit attachment route is not automatic request attribution. */
  readonly approvalTargetSource?: "request_metadata" | "tool_argument";
}

export interface McpMutationReplayObservation extends McpRequestAttributionObservation {
  readonly invocationIdentityInputs?: MutationIdentityInputPresence;
  readonly observedAtUnixMs?: number;
  readonly nativeDispatchStarted?: boolean;
  readonly requestSignalAborted?: boolean;
  /** The observed signal boundary, not an inference about who cancelled it. */
  readonly cancellationSource?: "sdk_request_signal";
  readonly surface: "compat" | "full";
  readonly mcpToolName: string;
  readonly operationId?: string;
  readonly identityMode?: "explicit" | "legacy";
  readonly disposition:
    | "execute"
    | "join"
    | "replay"
    | "outcome_unknown"
    | "conflict"
    | "ambiguous"
    | "store_failure"
    | "dispatch"
    | "request_signal_aborted"
    | "native_settled";
}

export interface MutationIdentityInputPresence {
  readonly argument: boolean;
  readonly omnicodexMeta: boolean;
  readonly openAiMeta: boolean;
}

export interface McpReadInvocationObservation extends McpRequestAttributionObservation {
  readonly workSessionBindingSha256?: string;
  readonly surface: "compat" | "full";
  readonly mcpToolName: string;
  readonly invocationIdSha256: string;
  readonly targetIdentitySha256: string;
  readonly resourceDigestSha256: string;
  readonly requestFingerprintSha256: string;
  readonly identityMode: "explicit" | "transport";
  readonly disposition:
    | "execute"
    | "dispatch"
    | "join"
    | "replay"
    | "conflict"
    | "coordinator_failure";
}

export interface OmniCodexMcpServerHandle {
  readonly server: Server;
  readonly catalog: NativeToolCatalog;
  readonly executor: NativeToolExecutor;
  readonly appServerMethodCatalog: AppServerMethodCatalog | undefined;
  readonly appServerMethodExecutor: AppServerMethodExecutor;
  readonly responsesToolCatalog: ResponsesNativeToolCatalog | undefined;
  readonly responsesToolExecutor: ResponsesNativeToolExecutor | undefined;
  readonly scheduler: NativeExecutionScheduler;
  /** Exact model-free native dispatcher; safe to retain for runtime-owned schedules. */
  readonly directJobDispatchAdapter: DirectJobDispatchAdapter;
  classifyToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<"model" | "non_model" | "unknown">;
  refresh(): Promise<void>;
}

/**
 * Owns the durable Goal half of one exact native call. Mutation replay has its
 * own ledger; the dispatcher coordinates both ledgers at the last possible
 * pre-I/O boundary and never treats a replay or joined call as fresh evidence.
 */
class DirectGoalExecutionLifecycle {
  readonly #store: DirectGoalStore;
  readonly #input: DirectGoalExecutionAuthorization;
  #begun = false;
  #dispatched = false;

  constructor(store: DirectGoalStore, input: DirectGoalExecutionAuthorization) {
    this.#store = store;
    this.#input = input;
  }

  get dispatched(): boolean {
    return this.#dispatched;
  }

  async begin(): Promise<void> {
    const reservation = await beginDirectGoalExecution(this.#store, this.#input);
    if (reservation.disposition !== "created") {
      throw new Error(`DIRECT_GOAL_EXECUTION_${reservation.disposition.toUpperCase()}`);
    }
    this.#begun = true;
  }

  async markDispatched(): Promise<void> {
    const reservation = await markDirectGoalExecutionDispatched(this.#store, this.#input);
    if (reservation.disposition !== "updated") {
      throw new Error(`DIRECT_GOAL_EXECUTION_${reservation.disposition.toUpperCase()}`);
    }
    this.#dispatched = true;
  }

  async abortBeforeDispatch(): Promise<void> {
    if (!this.#begun || this.#dispatched) return;
    await abortDirectGoalExecutionBeforeDispatch(this.#store, this.#input);
    this.#begun = false;
  }

  async markOutcomeUnknown(): Promise<void> {
    if (!this.#begun) return;
    await markDirectGoalExecutionOutcomeUnknown(this.#store, this.#input);
  }

  async finalize(result: CallToolResult): Promise<void> {
    await finalizeDirectGoalExecution(this.#store, {
      ...this.#input,
      outcome: resultOutcome(result) === "succeeded" ? "succeeded" : "tool_error",
      result,
    });
    this.#begun = false;
  }
}

const genericToolNames = ["search_native_tools", "call_native_tool", "app_server_rpc"] as const;
const deliveredCuaDocumentationByExecutor = new WeakMap<object, Set<string>>();
const deliveredCuaDocumentationByWorkSession = new Map<string, Set<string>>();
const OMNICODEX_SESSION_IDENTITY_TOOL = "codex__omnicodex__session_identity";
const OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL = "codex__omnicodex__browser_activity_stop";
export const OMNICODEX_ATTACH_LOCAL_FILE_TOOL = "codex__omnicodex__attach_local_file";
const reservedToolNames = [
  ...genericToolNames,
  OMNICODEX_SESSION_IDENTITY_TOOL,
  OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL,
  PROTECTED_RESULT_READ_TOOL,
  LEGACY_MUTATION_STATUS_TOOL,
  OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
  ...directGoalTools().map((tool) => tool.name),
  ...directJobTools().map((tool) => tool.name),
  ...directScheduleTools().map((tool) => tool.name),
];

// Publish the complete live registry through lossless, revision-bound
// tools/list pages. Framing limits one response, never the total catalog.
const OMNICODEX_INVOCATION_ID = "omnicodexInvocationId";
const LOCAL_FULL_CATALOG_CURSOR_SCOPE = "omnicodex-local-full-catalog-inspector";

/** One daemon-owned registry shared by every MCP session and local readback. */
export class OmniCodexNativeToolRegistryCatalog {
  readonly nativeToolCatalog: NativeToolCatalog;
  /** Immutable contract bit included in every generation produced by this catalog. */
  readonly directGoalsEnabled: boolean;
  /** Immutable contract bit included in every generation produced by this catalog. */
  readonly directJobsEnabled: boolean;
  /** Immutable contract bit included in every generation produced by this catalog. */
  readonly directSchedulesEnabled: boolean;
  readonly #options: OmniCodexFullCatalogSnapshotOptions;
  #current: NativeToolRegistrySnapshot | undefined;
  readonly #snapshots = new Map<string, NativeToolRegistrySnapshot>();
  readonly #hostSnapshots = new Map<string, CodexAppHostToolCatalogSnapshot>();
  readonly #unavailableTools = new Map<string, { server: string; toolsError: string }>();
  #refreshInFlight: Promise<NativeToolRegistrySnapshot> | undefined;

  constructor(options: OmniCodexFullCatalogSnapshotOptions) {
    this.#options = options;
    this.directGoalsEnabled = options.directGoalStore !== undefined;
    this.directJobsEnabled = options.directJobManager !== undefined;
    this.directSchedulesEnabled = options.directScheduleManager !== undefined;
    this.nativeToolCatalog =
      options.nativeToolCatalog ??
      new NativeToolCatalog(options.appServer, {
        reservedNames: reservedToolNames,
        selfServerName: OMNICODEX_MCP_SERVER_NAME,
        ...(options.serverIdentity === undefined
          ? {}
          : { selfServerIdentity: options.serverIdentity }),
      });
  }

  get current(): NativeToolRegistrySnapshot | undefined {
    return this.#current;
  }

  snapshot(revision: string): NativeToolRegistrySnapshot | undefined {
    return this.#snapshots.get(revision);
  }

  hostSnapshot(revision: string): CodexAppHostToolCatalogSnapshot | undefined {
    return this.#hostSnapshots.get(revision);
  }

  /** Only names previously published by this registry can inherit a server failure. */
  unavailableTool(
    name: string,
  ): { readonly server: string; readonly toolsError: string } | undefined {
    return this.#unavailableTools.get(name);
  }

  async refresh(): Promise<NativeToolRegistrySnapshot> {
    if (this.#refreshInFlight !== undefined) return this.#refreshInFlight;
    let operation!: Promise<NativeToolRegistrySnapshot>;
    operation = refreshNativeToolRegistry({
      catalog: this.nativeToolCatalog,
      codexAppHostToolExecutor: this.#options.codexAppHostToolExecutor,
      ...(this.#options.appServerMethodCatalog === undefined
        ? {}
        : { appServerMethodCatalog: this.#options.appServerMethodCatalog }),
      ...(this.#options.responsesToolCatalog === undefined
        ? {}
        : { responsesToolCatalog: this.#options.responsesToolCatalog }),
      includeBrowserNative: this.#options.browserNativeExecutor !== undefined,
      includeDirectGoals: this.#options.directGoalStore !== undefined,
      includeDirectJobs: this.#options.directJobManager !== undefined,
      includeDirectSchedules: this.#options.directScheduleManager !== undefined,
      protectMutations: this.#options.mutationReplayStore !== undefined,
      ...(this.#options.serverIdentity === undefined
        ? {}
        : { serverIdentity: this.#options.serverIdentity }),
    })
      .then(({ registry, hostSnapshot, serverErrors: observedErrors }) => {
        const serverErrors = new Map(
          observedErrors.map((failure) => [failure.server, failure.toolsError]),
        );
        const currentNames = new Set(registry.entries.map((entry) => entry.exposedName));
        // Retain only missing, previously observed names whose own server is
        // currently failing. Removed plugins and recovered servers leave no
        // stale aliases or descriptors in the live catalog.
        for (const entry of this.#current?.entries ?? []) {
          if (entry.route !== "downstream") continue;
          const toolsError = serverErrors.get(entry.descriptor.server);
          if (toolsError !== undefined)
            this.#unavailableTools.set(entry.exposedName, {
              server: entry.descriptor.server,
              toolsError,
            });
        }
        for (const [name, failure] of this.#unavailableTools) {
          const toolsError = serverErrors.get(failure.server);
          if (currentNames.has(name) || toolsError === undefined)
            this.#unavailableTools.delete(name);
          else this.#unavailableTools.set(name, { server: failure.server, toolsError });
        }
        this.#current = registry;
        this.#snapshots.clear();
        this.#hostSnapshots.clear();
        this.#snapshots.set(registry.revision, registry);
        this.#hostSnapshots.set(registry.revision, hostSnapshot);
        return registry;
      })
      .finally(() => {
        if (this.#refreshInFlight === operation) this.#refreshInFlight = undefined;
      });
    this.#refreshInFlight = operation;
    return operation;
  }

  async inspectFullCatalog(): Promise<OmniCodexFullCatalogSnapshot> {
    // Inspect the exact immutable generation already published by the daemon.
    // Building full native entries is intentionally done once: descriptions
    // such as functions.exec can be very large, so rebuilding the same array
    // for every transport page multiplies memory without adding evidence.
    const registry = this.#current ?? (await this.refresh());
    const hostSnapshot = this.#hostSnapshots.get(registry.revision);
    if (hostSnapshot === undefined) {
      throw new Error("LIVE_LOCAL_HOST_CATALOG_GENERATION_UNAVAILABLE");
    }
    const internalEntries = fullCatalogEntries(
      registry,
      hostSnapshot,
      this.#options.browserNativeExecutor !== undefined,
      this.#options.mutationReplayStore !== undefined,
      this.#options.directGoalStore !== undefined,
      this.#options.directJobManager !== undefined,
      this.#options.directScheduleManager !== undefined,
    );
    const pageToolCounts: number[] = [];
    const advertisedToolNames: string[] = [];
    let cursor: string | undefined;
    let criticalObservation:
      | Pick<
          Required<McpToolCatalogObservation>,
          | "criticalToolProperties"
          | "criticalToolRequired"
          | "criticalToolDescriptionSha256"
          | "criticalToolInputSchemaSha256"
        >
      | undefined;
    do {
      const page = fullToolPageFromEntries(
        registry,
        internalEntries,
        cursor,
        LOCAL_FULL_CATALOG_CURSOR_SCOPE,
        this.#options.serverIdentity,
      );
      const observation = toolCatalogObservation(
        "full",
        registry,
        cursor,
        page,
        CRITICAL_DIRECT_EXEC_TOOL,
      );
      pageToolCounts.push(observation.toolCount);
      advertisedToolNames.push(...page.tools.map(({ name }) => name));
      if (observation.criticalToolCount === 1) {
        if (criticalObservation !== undefined) {
          throw new Error("LIVE_LOCAL_CRITICAL_TOOL_SCHEMA_AMBIGUOUS");
        }
        if (
          observation.criticalToolProperties === undefined ||
          observation.criticalToolRequired === undefined ||
          observation.criticalToolDescriptionSha256 === undefined ||
          observation.criticalToolInputSchemaSha256 === undefined
        ) {
          throw new Error("LIVE_LOCAL_CRITICAL_TOOL_SCHEMA_UNAVAILABLE");
        }
        criticalObservation = {
          criticalToolProperties: observation.criticalToolProperties,
          criticalToolRequired: observation.criticalToolRequired,
          criticalToolDescriptionSha256: observation.criticalToolDescriptionSha256,
          criticalToolInputSchemaSha256: observation.criticalToolInputSchemaSha256,
        };
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    const catalogToolNames = [...advertisedToolNames].sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    if (new Set(catalogToolNames).size !== catalogToolNames.length) {
      throw new Error("LIVE_LOCAL_CATALOG_TOOL_NAMES_AMBIGUOUS");
    }
    const chatGptActionPage = actionCatalogToolPageFromEntries(
      internalEntries,
      this.#options.actionCatalogByteBudget ?? OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET,
      this.#options.serverIdentity,
    );
    if (chatGptActionPage.nextCursor !== undefined) {
      throw new Error("LIVE_LOCAL_CHATGPT_ACTION_CATALOG_MUST_BE_SINGLE_PAGE");
    }
    const chatGptObservation = toolCatalogObservation(
      "full",
      registry,
      undefined,
      chatGptActionPage,
      CRITICAL_CHATGPT_ACTION_TOOL,
    );
    if (
      chatGptObservation.criticalToolCount !== 1 ||
      chatGptObservation.criticalToolProperties === undefined ||
      chatGptObservation.criticalToolRequired === undefined ||
      chatGptObservation.criticalToolDescriptionSha256 === undefined ||
      chatGptObservation.criticalToolInputSchemaSha256 === undefined
    ) {
      throw new Error("LIVE_LOCAL_CHATGPT_CRITICAL_TOOL_SCHEMA_UNAVAILABLE");
    }
    const chatGptActionToolNames = chatGptActionPage.tools
      .map(({ name }) => name)
      .sort((left, right) => left.localeCompare(right, "en"));
    if (new Set(chatGptActionToolNames).size !== chatGptActionToolNames.length) {
      throw new Error("LIVE_LOCAL_CHATGPT_ACTION_TOOL_NAMES_AMBIGUOUS");
    }
    const catalogIdentities = internalEntries.map(({ name, toolId, revisionIdentity }) => ({
      name,
      toolId,
      ...revisionIdentity,
    }));
    const chatGptActionContractItems = [...chatGptActionPage.tools]
      .sort((left, right) => left.name.localeCompare(right.name, "en"))
      .map((tool) => ({
        name: tool.name,
        sha256: semanticDigest(withoutCatalogRevision(tool)),
      }));
    return {
      catalogRevision: registry.revision,
      catalogToolCount: pageToolCounts.reduce((sum, count) => sum + count, 0),
      catalogPageToolCounts: pageToolCounts,
      catalogToolNames,
      catalogToolNamesSha256: semanticDigest(catalogToolNames),
      catalogIdentitySha256: semanticDigest(catalogIdentities),
      modelToolCount: internalEntries.filter(
        ({ revisionIdentity }) => revisionIdentity.modelEffect === "model",
      ).length,
      unknownModelEffectCount: internalEntries.filter(
        ({ revisionIdentity }) => revisionIdentity.modelEffect === "unknown",
      ).length,
      // A missing native code-mode entry is reported as missing, not replaced
      // with the router's schema. It must not block publishing the actual
      // ChatGPT action surface or refreshing its independently verified router.
      ...criticalObservation,
      chatGptActionToolCount: chatGptActionToolNames.length,
      chatGptActionToolNames,
      chatGptActionToolNamesSha256: semanticDigest(chatGptActionToolNames),
      chatGptActionContractItems,
      chatGptActionContractSha256: semanticDigest(
        [...chatGptActionPage.tools]
          .sort((left, right) => left.name.localeCompare(right.name, "en"))
          .map(withoutCatalogRevision),
      ),
      chatGptCriticalToolName: CRITICAL_CHATGPT_ACTION_TOOL,
      chatGptCriticalToolProperties: chatGptObservation.criticalToolProperties,
      chatGptCriticalToolRequired: chatGptObservation.criticalToolRequired,
      chatGptCriticalToolDescriptionSha256: chatGptObservation.criticalToolDescriptionSha256,
      chatGptCriticalToolInputSchemaSha256: chatGptObservation.criticalToolInputSchemaSha256,
    };
  }
}

/**
 * Creates the stable and dynamic MCP surfaces over an App Server JSON-RPC
 * client. The low-level Server API is used so downstream JSON Schemas remain
 * untouched instead of being reduced to a Zod subset.
 */
export function createOmniCodexMcpServer(
  options: OmniCodexMcpServerOptions,
): OmniCodexMcpServerHandle {
  if (
    (options.mutationReplayStore === undefined) !== (options.authorizationBinding === undefined) &&
    options.runtimeDispatchOnly !== true
  ) {
    throw new Error("Mutation replay requires both the shared store and authorization binding");
  }
  if (
    options.legacyMutationCoordinator !== undefined &&
    options.authorizationBinding === undefined &&
    options.runtimeDispatchOnly !== true
  ) {
    throw new Error("Legacy mutation coordination requires an authorization binding");
  }
  if (
    options.directGoalStore !== undefined &&
    options.authorizationBinding === undefined &&
    options.runtimeDispatchOnly !== true
  ) {
    throw new Error("Direct Goals require an authorization binding");
  }
  if (
    options.directJobManager !== undefined &&
    (options.authorizationBinding === undefined ||
      options.correlationId === undefined ||
      options.resolveDurableWorkSessionBinding === undefined) &&
    options.runtimeDispatchOnly !== true
  ) {
    throw new Error(
      "Direct jobs require authorization, caller-session, and durable work-session bindings",
    );
  }
  if (
    options.directScheduleManager !== undefined &&
    (options.directJobManager === undefined ||
      options.authorizationBinding === undefined ||
      options.correlationId === undefined ||
      options.resolveDurableWorkSessionBinding === undefined) &&
    options.runtimeDispatchOnly !== true
  ) {
    throw new Error(
      "Direct schedules require direct jobs, authorization, caller-session, and durable work-session bindings",
    );
  }
  const executor = options.nativeToolExecutor ?? new NativeToolExecutor(options.appServer);
  const appServerMethodCatalog = options.appServerMethodCatalog;
  const appServerMethodExecutor =
    options.appServerMethodExecutor ?? new AppServerMethodExecutor(options.appServer);
  const surface = options.surface ?? "full";
  const responsesToolCatalog = options.responsesToolCatalog;
  const responsesToolExecutor = options.responsesToolExecutor;
  const codexAppHostToolExecutor =
    options.codexAppHostToolExecutor ??
    new CodexAppHostToolExecutor(options.appServer, {
      ...(options.desktopIpcClient === undefined
        ? {}
        : { threadMessages: options.desktopIpcClient }),
    });
  const registryCatalog =
    options.nativeToolRegistryCatalog ??
    new OmniCodexNativeToolRegistryCatalog({
      appServer: options.appServer,
      codexAppHostToolExecutor,
      ...(options.nativeToolCatalog === undefined
        ? {}
        : { nativeToolCatalog: options.nativeToolCatalog }),
      ...(appServerMethodCatalog === undefined ? {} : { appServerMethodCatalog }),
      ...(responsesToolCatalog === undefined ? {} : { responsesToolCatalog }),
      ...(options.browserNativeExecutor === undefined
        ? {}
        : { browserNativeExecutor: options.browserNativeExecutor }),
      ...(options.mutationReplayStore === undefined
        ? {}
        : { mutationReplayStore: options.mutationReplayStore }),
      ...(options.serverIdentity === undefined ? {} : { serverIdentity: options.serverIdentity }),
      ...(options.directGoalStore === undefined
        ? {}
        : { directGoalStore: options.directGoalStore }),
      ...(options.directJobManager === undefined
        ? {}
        : { directJobManager: options.directJobManager }),
      ...(options.directScheduleManager === undefined
        ? {}
        : { directScheduleManager: options.directScheduleManager }),
    });
  if (registryCatalog.directGoalsEnabled !== (options.directGoalStore !== undefined)) {
    throw new Error(
      "Shared native tool registry Direct Goal capability does not match this MCP server",
    );
  }
  if (registryCatalog.directJobsEnabled !== (options.directJobManager !== undefined)) {
    throw new Error(
      "Shared native tool registry Direct Job capability does not match this MCP server",
    );
  }
  if (registryCatalog.directSchedulesEnabled !== (options.directScheduleManager !== undefined)) {
    throw new Error(
      "Shared native tool registry Direct Schedule capability does not match this MCP server",
    );
  }
  const catalog = registryCatalog.nativeToolCatalog;
  const scheduler = options.scheduler ?? new NativeExecutionScheduler();
  const readInvocationCoordinator =
    options.readInvocationCoordinator ?? new ReadInvocationCoordinator();
  const server = new Server(
    {
      name: OMNICODEX_MCP_SERVER_NAME,
      version: options.serverVersion ?? "0.0.0-development",
    },
    {
      capabilities: { tools: { listChanged: true }, resources: {} },
    },
  );
  let currentRegistry: NativeToolRegistrySnapshot | undefined;

  server.setRequestHandler("resources/list", async () => ({
    resources: [
      {
        uri: OMNICODEX_ACTIVITY_RESOURCE_URI,
        name: "omnicodex-activity",
        title: "OmniCodex native tool activity",
        description:
          "Compact persisted status for one native OmniCodex tool result. It never duplicates the native result body.",
        mimeType: OMNICODEX_ACTIVITY_RESOURCE_MIME_TYPE,
      },
    ],
  }));
  server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [] }));
  server.setRequestHandler("resources/read", async (request) => {
    if (request.params.uri !== OMNICODEX_ACTIVITY_RESOURCE_URI) {
      const linked = await options.readLinkedResource?.(request.params.uri);
      if (linked !== undefined) return linked;
      throw new ResourceNotFoundError(request.params.uri);
    }
    return {
      contents: [
        {
          uri: OMNICODEX_ACTIVITY_RESOURCE_URI,
          mimeType: OMNICODEX_ACTIVITY_RESOURCE_MIME_TYPE,
          text: OMNICODEX_ACTIVITY_RESOURCE_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
            "openai/widgetDescription":
              "A compact authoritative status row for the completed OmniCodex native tool call; the native result remains in the conversation result envelope.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          },
        },
      ],
    };
  });

  const refreshRegistry = async (): Promise<NativeToolRegistrySnapshot> => {
    const effective = await registryCatalog.refresh();
    const changed =
      currentRegistry !== undefined && currentRegistry.revision !== effective.revision;
    currentRegistry = effective;
    if (changed) await server.sendToolListChanged();
    return effective;
  };

  const registryForCall = (): Promise<NativeToolRegistrySnapshot> =>
    registryCatalog.current === undefined
      ? refreshRegistry()
      : Promise.resolve(registryCatalog.current);
  const hostCatalogForRegistry = (
    registry: NativeToolRegistrySnapshot,
  ): CodexAppHostToolCatalogSnapshot => {
    const snapshot = registryCatalog.hostSnapshot(registry.revision);
    if (snapshot === undefined) throw new Error("HOST_CATALOG_GENERATION_UNAVAILABLE");
    return snapshot;
  };
  const operationNamespace = randomUUID();
  const fullCursorScope =
    options.authorizationBinding === undefined
      ? `session:${operationNamespace}`
      : `owner:${options.authorizationBinding}`;
  let advertisedFullEntriesCache:
    | {
        readonly registry: NativeToolRegistrySnapshot;
        readonly byName: ReadonlyMap<string, FullCatalogEntry>;
        readonly directActionNames: ReadonlySet<string>;
      }
    | undefined;
  const ensureAdvertisedFullEntries = (
    registry: NativeToolRegistrySnapshot,
  ): NonNullable<typeof advertisedFullEntriesCache> => {
    if (advertisedFullEntriesCache?.registry === registry) return advertisedFullEntriesCache;
    const entries = fullCatalogEntries(
      registry,
      hostCatalogForRegistry(registry),
      options.browserNativeExecutor !== undefined,
      options.mutationReplayStore !== undefined,
      options.directGoalStore !== undefined,
      options.directJobManager !== undefined,
      options.directScheduleManager !== undefined,
    );
    const advertisedTools =
      options.actionCatalogByteBudget === undefined
        ? entries.map((entry) => entry.tool)
        : actionCatalogToolPageFromEntries(
            entries,
            options.actionCatalogByteBudget,
            options.serverIdentity,
          ).tools;
    const advertisedToolNames = new Set(advertisedTools.map((tool) => tool.name));
    const advertisedToolIds = new Set(
      advertisedTools
        .map((tool) => objectValue(tool._meta?.omnicodex).toolId)
        .filter((toolId): toolId is string => typeof toolId === "string"),
    );
    const directActionNames = new Set(
      entries
        .filter(
          (entry) => advertisedToolNames.has(entry.name) || advertisedToolIds.has(entry.toolId),
        )
        .map((entry) => entry.name),
    );
    advertisedFullEntriesCache = {
      registry,
      byName: new Map(entries.map((entry) => [entry.name, entry])),
      directActionNames,
    };
    return advertisedFullEntriesCache;
  };
  const advertisedFullEntry = (
    registry: NativeToolRegistrySnapshot,
    name: string,
  ): FullCatalogEntry | undefined => ensureAdvertisedFullEntries(registry).byName.get(name);

  server.setRequestHandler("tools/list", async (request) => {
    const requestAttribution = options.resolveRequestAttribution?.();
    const cursor = request.params?.cursor;
    // tools/list reads the daemon-owned published generation. It must not
    // silently create another generation on the first page: a dynamic native
    // source could otherwise change revisions between local readback and the
    // public MCP response, or between concurrent clients. Explicit refresh
    // paths atomically replace this snapshot and emit list_changed.
    const refreshed = registryCatalog.current ?? (await refreshRegistry());
    // Remember the exact generation this MCP session actually observed. A
    // later explicit refresh can then emit list_changed for this session even
    // when another session created the shared registry before this list call.
    currentRegistry = refreshed;
    let result: ListToolsResult;
    result =
      options.actionCatalogByteBudget === undefined
        ? fullToolPage(
            refreshed,
            cursor,
            options.browserNativeExecutor !== undefined,
            hostCatalogForRegistry(refreshed),
            options.mutationReplayStore !== undefined,
            options.directGoalStore !== undefined,
            options.directJobManager !== undefined,
            options.directScheduleManager !== undefined,
            fullCursorScope,
            options.serverIdentity,
          )
        : actionCatalogToolPage(
            refreshed,
            cursor,
            options.browserNativeExecutor !== undefined,
            hostCatalogForRegistry(refreshed),
            options.mutationReplayStore !== undefined,
            options.directGoalStore !== undefined,
            options.directJobManager !== undefined,
            options.directScheduleManager !== undefined,
            options.actionCatalogByteBudget,
            options.serverIdentity,
          );
    result = {
      ...result,
      tools: result.tools.map(withAllFalseCatalogAnnotations),
    };
    const serverIdentity = options.serverIdentity;
    if (surface === "compat" && serverIdentity !== undefined) {
      result = {
        ...result,
        tools: result.tools.map((tool) => withOmniCodexServerIdentity(tool, serverIdentity)),
      };
    }
    await observeToolCatalog(options, {
      ...requestAttributionObservation(requestAttribution),
      ...toolCatalogObservation(
        surface,
        refreshed,
        cursor,
        result,
        options.actionCatalogByteBudget === undefined
          ? CRITICAL_DIRECT_EXEC_TOOL
          : CRITICAL_CHATGPT_ACTION_TOOL,
      ),
    });
    return result as unknown as ModernListToolsResult;
  });

  const dispatchToolCall = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onNativeProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
    operationId?: string,
    propagateFailure = false,
    beforeNativeDispatch?: () => Promise<void>,
    targetIdentity = name,
    browserCallContext: BrowserNativeCallContext = {},
    invocationIdSha256?: string,
    requestAttribution?: McpRequestAttributionObservation,
    browserStopOutcome?: BrowserActivityStopOutcome,
  ): Promise<CallToolResult> => {
    let observation: Omit<NativeToolExecutionObservation, "outcome"> = {
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...requestAttributionObservation(requestAttribution),
      ...browserCallerAttributionObservation(browserCallContext),
      ...(invocationIdSha256 === undefined ? {} : { invocationIdSha256 }),
      resourceDigestSha256: directGoalResourceDigest(
        nativeExecutionOrderingFromArguments(args),
        targetIdentity,
      ),
      surface,
      mcpToolName: name,
      operation: name === "search_native_tools" ? "search" : "native_call",
    };
    const observedBrowserContext = (
      context: BrowserNativeCallContext,
    ): BrowserNativeCallContext => ({
      ...context,
      observeExecutionStage: (browserExecutionStage) => {
        observation = { ...observation, browserExecutionStage };
      },
    });
    try {
      const registry = await registryForCall();
      const advertisedEntry = advertisedFullEntry(registry, name);
      const dispatchName = advertisedEntry?.dispatchName ?? name;
      if (name === OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL) {
        const stop = requireBrowserActivityStop(options, browserCallContext, args);
        if (browserStopOutcome === undefined)
          throw new Error("BROWSER_ACTIVITY_STOP_OUTCOME_TRACKER_REQUIRED");
        observation = {
          ...observation,
          targetNativeName: "browser_activity_stop",
          targetNamespace: "omnicodex",
          targetRoute: "mcp_control",
          modelEffect: "none",
          stateEffect: "mutate",
        };
        // Mark retiring and drain admitted calls before reserving their native
        // lanes. Holding a lane while waiting for those calls would deadlock.
        await stop.finishCurrentActivity(stop.executor, browserCallContext, async (cleanup) => {
          await scheduler.run(
            {
              ownerId: stop.ownerBinding,
              sessionId: stop.workSessionBinding,
              entry: {
                nativeNamespace: "omnicodex",
                originalName: "browser_activity_stop",
                source: "omnicodex",
                modelEffect: "none",
                stateEffect: "mutate",
              },
              ...(operationId === undefined ? {} : { operationId }),
              ...(signal === undefined ? {} : { signal }),
            },
            async (operationSignal) => {
              // One durable semantic cohort covers every caller identity mode.
              // A distinct physical attempt gets a server-owned session identity,
              // so the legacy coordinator cannot treat a new request ID on the
              // same transport as permission to bypass an unresolved Stop.
              const fenceOperationId = operationId ?? randomUUID();
              const fence = await stop.mutationCoordinator.acquire<null>({
                authorizationBinding: stop.ownerBinding,
                semanticDigest: semanticDigest({
                  contract: "omnicodex-browser-activity-stop-fence-v1",
                  workSessionBinding: stop.workSessionBinding,
                  target: "browser_activity_stop",
                }),
                sessionId: `browser-stop-fence:${fenceOperationId}`,
                requestId: "cleanup",
              });
              if (fence.kind !== "execute")
                throw new Error("BROWSER_ACTIVITY_STOP_FENCE_REQUIRES_FRESH_OPERATION");
              browserStopOutcome.execution = fence.execution;
              let cleanupEntered = false;
              try {
                operationSignal?.throwIfAborted();
                // Defer the mutation boundary until the semantic fence admits
                // this attempt under the scheduler's owner/Work resource lock.
                await beforeNativeDispatch?.();
                operationSignal?.throwIfAborted();
                cleanupEntered = true;
                await cleanup();
                // Keep the durable fence unresolved until the outer mutation
                // receipt commits too; a result-commit error is still UNKNOWN.
                browserStopOutcome.cleanupSucceeded = true;
              } catch (error) {
                await (cleanupEntered
                  ? fence.execution.outcomeUnknown("BROWSER_ACTIVITY_STOP_CLEANUP_UNKNOWN")
                  : fence.execution.failBeforeDispatch("BROWSER_ACTIVITY_STOP_NOT_ENTERED")
                ).catch(() => undefined);
                throw error;
              }
            },
          );
        });
        const result: CallToolResult = {
          content: [{ type: "text", text: "Browser activity stopped." }],
        };
        await observeExecution(options, {
          ...observation,
          ...resultSummary(result),
          outcome: "succeeded",
        });
        return result;
      }
      if (name === "search_native_tools") {
        await beforeNativeDispatch?.();
        const result = await searchNativeTools(
          options.appServer,
          registry,
          args,
          hostCatalogForRegistry(registry),
          options.browserNativeExecutor !== undefined,
          options.mutationReplayStore !== undefined,
          options.directGoalStore !== undefined,
          options.directJobManager !== undefined,
          options.directScheduleManager !== undefined,
          surface === "full"
            ? ensureAdvertisedFullEntries(registry).directActionNames
            : new Set<string>(),
        );
        await observeExecution(options, {
          ...observation,
          ...resultSummary(result),
          outcome: resultOutcome(result),
        });
        return result;
      }
      if (name === "call_native_tool") {
        if (args.name === "search_native_tools") {
          const searchArgs = isObject(args.arguments) ? args.arguments : {};
          observation = {
            ...observation,
            operation: "search",
            targetNativeName: "search_native_tools",
            targetNamespace: "omnicodex",
            targetRoute: "mcp_control",
            modelEffect: "none",
            stateEffect: "read",
          };
          await beforeNativeDispatch?.();
          const result = await searchNativeTools(
            options.appServer,
            registry,
            searchArgs,
            hostCatalogForRegistry(registry),
            options.browserNativeExecutor !== undefined,
            options.mutationReplayStore !== undefined,
            options.directGoalStore !== undefined,
            options.directJobManager !== undefined,
            options.directScheduleManager !== undefined,
            surface === "full"
              ? ensureAdvertisedFullEntries(registry).directActionNames
              : new Set<string>(),
          );
          await observeExecution(options, {
            ...observation,
            ...resultSummary(result),
            outcome: resultOutcome(result),
          });
          return result;
        }
        const entry = genericTarget(
          registry,
          args,
          hostCatalogForRegistry(registry),
          options.browserNativeExecutor !== undefined,
        );
        if (entry === undefined && typeof args.name === "string") {
          const unavailable = registryCatalog.unavailableTool(args.name);
          if (unavailable !== undefined) {
            const result = unavailableNativeToolResult(unavailable);
            await observeExecution(options, {
              ...observation,
              ...resultSummary(result),
              outcome: "tool_error",
            });
            return result;
          }
        }
        if (entry !== undefined)
          observation = { ...observation, ...targetObservation(entry, args, true) };
        const dispatch = (effectiveBrowserCallContext: BrowserNativeCallContext) =>
          callNativeTool(
            registry,
            executor,
            responsesToolExecutor,
            appServerMethodExecutor,
            scheduler,
            codexAppHostToolExecutor,
            hostCatalogForRegistry(registry),
            options.browserNativeExecutor,
            args,
            signal,
            onNativeProgress,
            beforeNativeDispatch,
            operationId,
            browserCallContext.workSessionBinding ??
              browserCallContext.callerSessionId ??
              options.correlationId,
            observedBrowserContext(effectiveBrowserCallContext),
            options.browserActivityCoordinator,
          );
        const result =
          (entry?.route === "browser_native" ||
            (entry?.route === "downstream" &&
              entry.descriptor.originalName !== "turn_ended" &&
              isCuaNativeTool(entry.descriptor.server, entry.descriptor.originalName))) &&
          options.browserNativeExecutor !== undefined
            ? await withCoordinatedBrowserActivity(
                options,
                options.browserNativeExecutor,
                browserCallContext,
                dispatch,
              )
            : await dispatch(withoutExactBrowserConversationId(browserCallContext));
        await observeExecution(options, {
          ...observation,
          ...resultSummary(result),
          outcome: resultOutcome(result),
        });
        return result;
      }
      if (name === "app_server_rpc") {
        observation = {
          ...observation,
          operation: "app_server_rpc",
          targetRoute: "app_server_rpc",
          ...(typeof args.method === "string" ? { targetNativeName: args.method } : {}),
          ...privacySafeNativeRequestObservation(
            typeof args.method === "string" ? args.method : "app_server_rpc",
            undefined,
            args.params,
          ),
        };
        const result = await callAppServerRpc(
          appServerMethodExecutor,
          registry,
          args,
          scheduler,
          signal,
          beforeNativeDispatch,
          operationId,
        );
        await observeExecution(options, {
          ...observation,
          ...resultSummary(result),
          outcome: resultOutcome(result),
        });
        return result;
      }
      const browserNativeExecutor = options.browserNativeExecutor;
      const dispatchesBrowser =
        advertisedEntry === undefined
          ? isBrowserNativeTool(dispatchName)
          : advertisedEntry.dispatchKind === "browser";
      if (
        dispatchesBrowser &&
        isBrowserNativeTool(dispatchName) &&
        browserNativeExecutor !== undefined
      ) {
        // Reject a missing IAB identity before the scheduler's dispatch
        // boundary marks a durable mutation as started.
        browserContextThreadId(dispatchName, args);
        const browserIdentity = browserToolIdentity(dispatchName, args);
        observation = {
          ...observation,
          targetNativeName: browserIdentity.originalName,
          targetNamespace: browserIdentity.nativeNamespace,
          targetRoute: "browser_native",
          modelEffect: "none",
          stateEffect: browserIdentity.stateEffect,
          ...privacySafeNativeRequestObservation(dispatchName, "none", args),
        };
        const result = await withCoordinatedBrowserActivity(
          options,
          browserNativeExecutor,
          browserCallContext,
          (effectiveBrowserCallContext) =>
            scheduler.run(
              {
                entry: browserIdentity,
                ordering: nativeExecutionOrderingFromArguments(args),
                ...(operationId === undefined ? {} : { operationId }),
                ...(signal === undefined ? {} : { signal }),
                ...(beforeNativeDispatch === undefined
                  ? {}
                  : { beforeOperation: beforeNativeDispatch }),
                ...(isAuthoritativeBrowserResourceReadback(dispatchName, args)
                  ? { recoverUnknownResourcesWhen: successfulBrowserResourceReadback }
                  : {}),
              },
              (operationSignal) =>
                callBrowserNativeTool(
                  browserNativeExecutor,
                  dispatchName,
                  args,
                  operationSignal,
                  observedBrowserContext(effectiveBrowserCallContext),
                ),
            ),
        );
        await observeExecution(options, {
          ...observation,
          ...resultSummary(result),
          outcome: resultOutcome(result),
        });
        return result;
      }
      const codexAppTool =
        advertisedEntry === undefined || advertisedEntry.dispatchKind === "host"
          ? codexAppHostToolExecutor.descriptor(dispatchName)
          : undefined;
      if (codexAppTool !== undefined) {
        const hostIdentity = hostToolIdentity(codexAppTool);
        const deferNativeDispatchBoundary = dispatchName === "codex_app__send_message_to_thread";
        observation = {
          ...observation,
          targetNativeName: codexAppTool.nativeName,
          targetNamespace: hostIdentity.nativeNamespace,
          targetRoute: hostIdentity.route,
          modelEffect: codexAppTool.modelEffect,
          stateEffect: codexAppTool.stateEffect,
          ...privacySafeNativeRequestObservation(
            codexAppTool.nativeName,
            codexAppTool.modelEffect,
            args,
          ),
        };
        const nativeResult = await scheduler.run(
          {
            entry: {
              nativeNamespace: hostIdentity.nativeNamespace,
              originalName: codexAppTool.nativeName,
              source: hostIdentity.source,
              modelEffect: codexAppTool.modelEffect,
              stateEffect: codexAppTool.stateEffect,
            },
            ordering: nativeExecutionOrderingFromArguments(args),
            ...(operationId === undefined ? {} : { operationId }),
            ...(signal === undefined ? {} : { signal }),
            ...(beforeNativeDispatch === undefined || deferNativeDispatchBoundary
              ? {}
              : { beforeOperation: beforeNativeDispatch }),
          },
          (operationSignal) =>
            codexAppHostToolExecutor.call(dispatchName, args, {
              operationId: operationId ?? randomUUID(),
              ...(browserCallContext.contextTurnId === undefined
                ? {}
                : { callingTurnId: browserCallContext.contextTurnId }),
              ...((browserCallContext.workSessionBinding ??
                browserCallContext.callerSessionId ??
                options.correlationId) === undefined
                ? {}
                : {
                    callerSessionId:
                      browserCallContext.workSessionBinding ??
                      browserCallContext.callerSessionId ??
                      options.correlationId,
                  }),
              ...(operationSignal === undefined ? {} : { signal: operationSignal }),
              ...(beforeNativeDispatch === undefined || !deferNativeDispatchBoundary
                ? {}
                : { beforeNativeDispatch }),
            }),
        );
        const result = toCallToolResult(
          nativeResult,
          {
            tool: dispatchName,
            source: hostIdentity.source,
            originalName: codexAppTool.nativeName,
            route: hostIdentity.route,
            modelEffect: codexAppTool.modelEffect,
            stateEffect: codexAppTool.stateEffect,
          },
          codexAppTool.tool.outputSchema,
        );
        await observeExecution(options, {
          ...observation,
          ...resultSummary(result),
          outcome: resultOutcome(result),
        });
        return result;
      }
      const entry =
        (advertisedEntry?.dispatchKind === "registry"
          ? registry.entries.find((item) => item.toolId === advertisedEntry.toolId)
          : registry.entries.find((item) => item.exposedName === dispatchName)) ??
        registry.entries.find(
          (item) =>
            item.route === "responses" &&
            item.originalName === dispatchName &&
            item.originalName.startsWith("codex_app__"),
        );
      if (entry === undefined) {
        const unavailable = registryCatalog.unavailableTool(name);
        const result =
          unavailable === undefined
            ? errorResult(`Unknown OmniCodex tool: ${name}`)
            : unavailableNativeToolResult(unavailable);
        await observeExecution(options, {
          ...observation,
          ...resultSummary(result),
          outcome: "tool_error",
        });
        return result;
      }
      observation = { ...observation, ...targetObservation(entry, args) };
      const dispatchRegistry = (effectiveBrowserCallContext: BrowserNativeCallContext) =>
        callRegistryEntry(
          entry,
          args,
          executor,
          responsesToolExecutor,
          appServerMethodExecutor,
          scheduler,
          undefined,
          undefined,
          signal,
          onNativeProgress,
          beforeNativeDispatch,
          operationId,
          browserCallContext.workSessionBinding,
          options.browserNativeExecutor,
          observedBrowserContext(effectiveBrowserCallContext),
          options.browserActivityCoordinator,
        );
      const result =
        entry.route === "downstream" &&
        entry.descriptor.originalName !== "turn_ended" &&
        isCuaNativeTool(entry.descriptor.server, entry.descriptor.originalName) &&
        options.browserNativeExecutor !== undefined
          ? await withCoordinatedBrowserActivity(
              options,
              options.browserNativeExecutor,
              browserCallContext,
              dispatchRegistry,
            )
          : await dispatchRegistry(withoutExactBrowserConversationId(browserCallContext));
      await observeExecution(options, {
        ...observation,
        ...resultSummary(result),
        outcome: resultOutcome(result),
      });
      return result;
    } catch (error) {
      await observeExecution(options, {
        ...observation,
        ...nativeExecutionFailureSummary(error),
        outcome: "failed",
      });
      if (propagateFailure) throw error;
      return errorResultFrom(error);
    }
  };

  const callStateContext = async (
    name: string,
    args: Record<string, unknown>,
    pinnedRegistry?: NativeToolRegistrySnapshot,
  ): Promise<{
    readonly catalogRevision: string;
    readonly stateEffect: "none" | "read" | "mutate";
    readonly modelEffect: "none" | "model" | "unknown";
    readonly targetIdentity: string;
    readonly targetContractDigest: string;
    readonly retrySafeAfterUnknown?: boolean;
  }> => {
    const registry = pinnedRegistry ?? (await registryForCall());
    const advertisedEntry = advertisedFullEntry(registry, name);
    const dispatchName = advertisedEntry?.dispatchName ?? name;
    if (name === OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL) {
      const entry = browserActivityStopCatalogEntry(registry.revision);
      return {
        catalogRevision: registry.revision,
        stateEffect: "mutate",
        modelEffect: "none",
        targetIdentity: entry.toolId,
        // Unrelated catalog refreshes cannot authorize replay of an unknown Stop.
        targetContractDigest: semanticDigest(withoutCatalogRevision(entry.tool)),
      };
    }
    if (name === "search_native_tools") {
      return {
        catalogRevision: registry.revision,
        stateEffect: "read",
        modelEffect: "none",
        targetIdentity: name,
        targetContractDigest: semanticDigest({ name, stateEffect: "read" }),
      };
    }
    const dispatchesBrowser =
      advertisedEntry === undefined
        ? isBrowserNativeTool(dispatchName)
        : advertisedEntry.dispatchKind === "browser";
    if (dispatchesBrowser && isBrowserNativeTool(dispatchName)) {
      const tool = browserNativeTools(
        browserExecutionTool(registry, hostCatalogForRegistry(registry)),
      ).find((candidate) => candidate.name === dispatchName);
      return {
        catalogRevision: registry.revision,
        stateEffect: browserNativeStateEffect(dispatchName, args),
        modelEffect: "none",
        targetIdentity: `browser_native\u0000${dispatchName}`,
        targetContractDigest: semanticDigest({
          name: dispatchName,
          inputSchema: tool?.inputSchema,
          annotations: tool?.annotations,
        }),
      };
    }
    const hostTool =
      advertisedEntry === undefined || advertisedEntry.dispatchKind === "host"
        ? codexAppHostToolExecutor.descriptor(dispatchName)
        : undefined;
    if (hostTool !== undefined) {
      const hostIdentity = hostToolIdentity(hostTool);
      return {
        catalogRevision: registry.revision,
        stateEffect: hostTool.stateEffect,
        modelEffect: hostTool.modelEffect,
        targetIdentity: `${hostIdentity.route}\u0000${hostIdentity.nativeNamespace}\u0000${hostTool.nativeName}`,
        targetContractDigest: semanticDigest({
          nativeName: hostTool.nativeName,
          nativeNamespace: hostIdentity.nativeNamespace,
          route: hostIdentity.route,
          modelEffect: hostTool.modelEffect,
          stateEffect: hostTool.stateEffect,
          inputSchema: hostTool.tool.inputSchema,
        }),
        ...(isIdempotentMcpServerReload(hostIdentity.nativeNamespace, hostTool.nativeName)
          ? { retrySafeAfterUnknown: true }
          : {}),
      };
    }
    const entry =
      name === "call_native_tool"
        ? genericTarget(
            registry,
            args,
            codexAppHostToolExecutor,
            options.browserNativeExecutor !== undefined,
          )
        : name === "app_server_rpc" && typeof args.method === "string"
          ? registry.entries.find(
              (candidate) =>
                candidate.route === "app_server" && candidate.originalName === args.method,
            )
          : advertisedEntry?.dispatchKind === "registry"
            ? registry.entries.find((candidate) => candidate.toolId === advertisedEntry.toolId)
            : registry.entries.find((candidate) => candidate.exposedName === dispatchName);
    if (entry !== undefined) {
      return {
        catalogRevision: registry.revision,
        stateEffect: entry.stateEffect,
        modelEffect: entry.modelEffect,
        targetIdentity: `${entry.route}\u0000${entry.toolId}\u0000${entry.originalName}`,
        targetContractDigest: semanticDigest({
          route: entry.route,
          originalName: entry.originalName,
          kind: entry.kind,
          modelEffect: entry.modelEffect,
          stateEffect: entry.stateEffect,
          inputSchema: entry.tool.inputSchema,
        }),
        ...(entry.route === "app_server" &&
        isIdempotentMcpServerReload(entry.nativeNamespace, entry.originalName)
          ? { retrySafeAfterUnknown: true }
          : {}),
      };
    }
    // An unclassified generic/raw target is conservatively treated as a
    // mutation. Validation still occurs in the native dispatcher, but it can
    // never bypass the shared replay boundary.
    if (name === "call_native_tool" || name === "app_server_rpc") {
      return {
        catalogRevision: registry.revision,
        stateEffect: "mutate",
        modelEffect: "unknown",
        targetIdentity: `${name}\u0000unclassified`,
        targetContractDigest: semanticDigest({ name, classification: "unclassified" }),
      };
    }
    return {
      catalogRevision: registry.revision,
      stateEffect: "none",
      modelEffect: "unknown",
      targetIdentity: name,
      targetContractDigest: semanticDigest({ name, stateEffect: "none" }),
    };
  };

  const resolveDirectJobTargetContract = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<DirectJobTargetContract> => {
    const registry = await registryForCall();
    const advertised = fullCatalogEntries(
      registry,
      hostCatalogForRegistry(registry),
      options.browserNativeExecutor !== undefined,
      options.mutationReplayStore !== undefined,
      options.directGoalStore !== undefined,
      options.directJobManager !== undefined,
      options.directScheduleManager !== undefined,
    ).some((entry) => entry.name === name);
    if (!advertised) throw new Error(`DIRECT_JOB_TARGET_NOT_FIRST_CLASS: ${name}`);
    const state = await callStateContext(name, args, registry);
    return {
      catalogRevision: state.catalogRevision,
      targetIdentity: state.targetIdentity,
      targetContractDigest: state.targetContractDigest,
      modelEffect: state.modelEffect,
    };
  };

  const assertDirectJobTargetContractCurrent = async (
    name: string,
    args: Record<string, unknown>,
    expected: DirectJobTargetContract,
  ): Promise<void> => {
    let current: DirectJobTargetContract;
    try {
      current = await resolveDirectJobTargetContract(name, args);
    } catch (error) {
      throw new Error(
        `DIRECT_JOB_CATALOG_CHANGED: Pinned native target is no longer available: ${toError(error).message}`,
        { cause: error },
      );
    }
    if (
      current.catalogRevision !== expected.catalogRevision ||
      current.targetIdentity !== expected.targetIdentity ||
      current.targetContractDigest !== expected.targetContractDigest ||
      current.modelEffect !== expected.modelEffect
    ) {
      throw new Error(
        "DIRECT_JOB_CATALOG_CHANGED: Pinned native target contract changed before dispatch",
      );
    }
  };

  const dispatchWithMutationReplay = async (
    name: string,
    args: Record<string, unknown>,
    requestMeta: unknown,
    legacySessionId: string,
    legacyRequestId: string | number,
    signal: AbortSignal | undefined,
    onNativeProgress: (event: NativeToolProgressEvent) => Promise<void> | void,
    fallbackOperationId: string,
    explicitDirectGoalContext: DirectGoalInvocationContext | undefined,
    ownerBinding: string | undefined,
    claimantBinding: string,
    browserCallContext: BrowserNativeCallContext,
    directJobDispatch?: {
      readonly targetContract: DirectJobTargetContract;
      readonly beforeNativeDispatch: () => Promise<void>;
    },
    transportReadInvocation?: ReadInvocationIdentity,
    requestAttribution?: McpRequestAttributionObservation,
    browserStopOutcome?: BrowserActivityStopOutcome,
  ): Promise<CallToolResult> => {
    const replayStore = options.mutationReplayStore;
    const legacyCoordinator = options.legacyMutationCoordinator;
    const split = mutationArguments(args, requestMeta);
    if (!split.ok) return errorResult(split.message);
    const invocationIdentityInputs = mutationIdentityInputPresence(args, requestMeta);
    const nativeArguments = split.arguments;
    if (name === OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL) {
      try {
        requireBrowserActivityStop(options, browserCallContext, nativeArguments);
      } catch (error) {
        return errorResultFrom(error);
      }
    }
    const stateContext = await callStateContext(name, nativeArguments);
    // Empty Stop arguments still identify a mutation in exactly one durable
    // Work session. An owner's other sessions must never join/replay its Stop.
    const context =
      name === OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL
        ? {
            ...stateContext,
            targetIdentity: `${stateContext.targetIdentity}:${semanticDigest(browserCallContext.workSessionBinding)}`,
          }
        : stateContext;
    const beforeNativeDispatch = (
      next?: () => Promise<void>,
    ): (() => Promise<void>) | undefined => {
      const invalidateTransientReads = context.stateEffect === "mutate";
      if (directJobDispatch === undefined && !invalidateTransientReads) return next;
      return async () => {
        if (directJobDispatch !== undefined) {
          await assertDirectJobTargetContractCurrent(
            name,
            nativeArguments,
            directJobDispatch.targetContract,
          );
          await directJobDispatch.beforeNativeDispatch();
        }
        if (invalidateTransientReads) readInvocationCoordinator.invalidateTransient();
        await next?.();
      };
    };
    const directGoalStore = options.directGoalStore;
    const goalOwnerBinding =
      ownerBinding !== undefined && browserCallContext.workSessionBinding !== undefined
        ? directGoalOwnerBinding(ownerBinding, browserCallContext.workSessionBinding)
        : undefined;
    let directGoalContext = explicitDirectGoalContext;
    if (directGoalContext !== undefined) {
      if (directGoalStore === undefined || goalOwnerBinding === undefined) {
        return errorResult("DIRECT_GOAL_STORE_UNAVAILABLE");
      }
    }
    const goalResourceDigest = directGoalResourceDigest(
      nativeExecutionOrderingFromArguments(nativeArguments),
      context.targetIdentity,
    );
    const unknownExecutionReadback: DirectGoalUnknownExecutionReadbackContext | undefined =
      directGoalContext === undefined &&
      directGoalStore !== undefined &&
      goalOwnerBinding !== undefined &&
      context.stateEffect === "read" &&
      context.modelEffect === "none" &&
      isAuthoritativeBrowserInspection(name, nativeArguments)
        ? await directGoalStore.resolveUnknownExecutionReadback({
            authorizationBinding: goalOwnerBinding,
            claimantBinding,
            resourceDigest: goalResourceDigest,
            stateEffect: "read",
            modelEffect: "none",
          })
        : undefined;
    const goalLifecycle = async (
      operationId: string,
    ): Promise<DirectGoalExecutionLifecycle | undefined> => {
      if (
        unknownExecutionReadback === undefined &&
        directGoalContext === undefined &&
        directGoalStore !== undefined &&
        goalOwnerBinding !== undefined
      ) {
        directGoalContext = await directGoalStore.resolvePendingExecution({
          authorizationBinding: goalOwnerBinding,
          claimantBinding,
          toolName: name,
          resourceDigest: goalResourceDigest,
          stateEffect: context.stateEffect,
          modelEffect: context.modelEffect,
        });
      }
      if (
        directGoalContext === undefined ||
        directGoalStore === undefined ||
        goalOwnerBinding === undefined
      ) {
        return undefined;
      }
      return new DirectGoalExecutionLifecycle(directGoalStore, {
        authorizationBinding: goalOwnerBinding,
        claimantBinding,
        context: directGoalContext,
        operationId,
        toolName: name,
        targetIdentity: context.targetIdentity,
        stateEffect: context.stateEffect,
        modelEffect: context.modelEffect,
        arguments: nativeArguments,
      });
    };
    if (ownerBinding === undefined) {
      return dispatchToolCall(
        name,
        nativeArguments,
        signal,
        onNativeProgress,
        fallbackOperationId,
        directJobDispatch !== undefined,
        beforeNativeDispatch(),
        context.targetIdentity,
        browserCallContext,
        split.invocationIdSha256,
        requestAttribution,
      );
    }
    const executeGoalRead = async (
      lifecycle: DirectGoalExecutionLifecycle,
      operationId: string,
      signal: AbortSignal | undefined,
      onPhysicalDispatch?: () => Promise<void>,
      invocationIdSha256 = split.invocationIdSha256,
    ): Promise<CallToolResult> => {
      try {
        await lifecycle.begin();
      } catch (error) {
        return errorResultFrom(error, "DIRECT_GOAL_PRECONDITION_FAILED");
      }
      try {
        const result = await dispatchToolCall(
          name,
          nativeArguments,
          signal,
          onNativeProgress,
          operationId,
          true,
          beforeNativeDispatch(async () => {
            await lifecycle.markDispatched();
            await onPhysicalDispatch?.();
          }),
          context.targetIdentity,
          browserCallContext,
          invocationIdSha256,
          requestAttribution,
        );
        if (!lifecycle.dispatched) {
          await lifecycle.abortBeforeDispatch().catch(() => undefined);
          return result;
        }
        try {
          await lifecycle.finalize(result);
          return result;
        } catch (error) {
          return errorResultFrom(error, "DIRECT_GOAL_EVIDENCE_COMMIT_FAILED");
        }
      } catch (error) {
        if (lifecycle.dispatched) {
          const failureResult = authoritativeNativeFailureResult(error);
          if (failureResult !== undefined) {
            try {
              await lifecycle.finalize(failureResult);
              return failureResult;
            } catch (finalizeError) {
              return errorResultFrom(finalizeError, "DIRECT_GOAL_EVIDENCE_COMMIT_FAILED");
            }
          }
          await lifecycle.markOutcomeUnknown().catch(() => undefined);
          return errorResultFrom(error, "DIRECT_GOAL_OUTCOME_UNKNOWN");
        }
        await lifecycle.abortBeforeDispatch().catch(() => undefined);
        return errorResultFrom(error, "DIRECT_GOAL_NOT_DISPATCHED");
      }
    };
    const executeUnknownExecutionReadback = async (
      recovery: DirectGoalUnknownExecutionReadbackContext,
      operationId: string,
      operationSignal: AbortSignal | undefined,
      onPhysicalDispatch?: () => Promise<void>,
      invocationIdSha256 = split.invocationIdSha256,
    ): Promise<CallToolResult> => {
      const nativeResourceLeaseCoordinator = options.nativeResourceLeaseCoordinator;
      if (nativeResourceLeaseCoordinator?.recoverUnknown === undefined) {
        return errorResult("DIRECT_GOAL_NATIVE_RESOURCE_LEASE_COORDINATOR_UNAVAILABLE");
      }
      const result = await dispatchToolCall(
        name,
        nativeArguments,
        operationSignal,
        onNativeProgress,
        operationId,
        false,
        beforeNativeDispatch(onPhysicalDispatch),
        context.targetIdentity,
        browserCallContext,
        invocationIdSha256,
        requestAttribution,
      );
      if (resultOutcome(result) !== "succeeded") return result;
      if (directGoalStore === undefined || goalOwnerBinding === undefined) {
        return errorResult("DIRECT_GOAL_STORE_UNAVAILABLE");
      }
      try {
        const recovered = await nativeResourceLeaseCoordinator.recoverUnknown(
          recovery.operationId,
          async (lease) => lease.state === "outcome_unknown",
        );
        if (!recovered) {
          throw new Error("DIRECT_GOAL_NATIVE_RESOURCE_UNKNOWN_LEASE_NOT_RECOVERED");
        }
        await directGoalStore.finalizeUnknownExecutionReadback({
          authorizationBinding: goalOwnerBinding,
          claimantBinding,
          resourceDigest: goalResourceDigest,
          stateEffect: "read",
          modelEffect: "none",
          context: recovery,
          proofOperationId: operationId,
          proofToolName: name,
          proofTargetIdentity: context.targetIdentity,
          proofResultDigest: semanticDigest(result),
        });
        return result;
      } catch (error) {
        return errorResultFrom(error, "DIRECT_GOAL_UNKNOWN_EXECUTION_READBACK_COMMIT_FAILED");
      }
    };
    if (context.stateEffect !== "mutate") {
      const lifecycle =
        directGoalContext === undefined ? undefined : await goalLifecycle(fallbackOperationId);
      if (lifecycle === undefined) {
        const executeRead = async (
          operationId: string,
          operationSignal: AbortSignal | undefined,
          onPhysicalDispatch?: () => Promise<void>,
          invocationIdSha256 = split.invocationIdSha256,
        ): Promise<CallToolResult> => {
          if (unknownExecutionReadback !== undefined) {
            return executeUnknownExecutionReadback(
              unknownExecutionReadback,
              operationId,
              operationSignal,
              onPhysicalDispatch,
              invocationIdSha256,
            );
          }
          const dynamicLifecycle = await goalLifecycle(operationId);
          if (dynamicLifecycle !== undefined)
            return executeGoalRead(
              dynamicLifecycle,
              operationId,
              operationSignal,
              onPhysicalDispatch,
              invocationIdSha256,
            );
          return dispatchToolCall(
            name,
            nativeArguments,
            operationSignal,
            onNativeProgress,
            operationId,
            directJobDispatch !== undefined,
            beforeNativeDispatch(onPhysicalDispatch),
            context.targetIdentity,
            browserCallContext,
            invocationIdSha256,
            requestAttribution,
          );
        };
        if (context.stateEffect !== "read" || directJobDispatch !== undefined) {
          return executeRead(fallbackOperationId, signal);
        }

        const requestFingerprintSha256 = semanticDigest({
          contract: "omnicodex-read-invocation-v1",
          targetIdentity: context.targetIdentity,
          targetContractDigest: context.targetContractDigest,
          arguments: readInvocationSemanticArguments(nativeArguments),
        });
        const invocationId = split.invocationId ?? transportReadInvocation?.invocationId;
        const invocationIdSha256 =
          split.invocationIdSha256 ?? transportReadInvocation?.invocationIdSha256;
        if (invocationId === undefined || invocationIdSha256 === undefined) {
          return executeRead(fallbackOperationId, signal);
        }
        const identityMode = split.invocationId === undefined ? "transport" : "explicit";
        const targetIdentitySha256 = createHash("sha256")
          .update(context.targetIdentity, "utf8")
          .digest("hex");
        const resourceDigestSha256 = directGoalResourceDigest(
          nativeExecutionOrderingFromArguments(nativeArguments),
          context.targetIdentity,
        );
        const observation = {
          ...requestAttributionObservation(requestAttribution),
          surface,
          mcpToolName: name,
          invocationIdSha256,
          identityMode,
          targetIdentitySha256,
          resourceDigestSha256,
          requestFingerprintSha256,
        } as const;
        let acquisition: ReadInvocationAcquisition<ReadInvocationJsonValue>;
        try {
          acquisition = readInvocationCoordinator.acquire<ReadInvocationJsonValue>({
            authorizationBinding: ownerBinding,
            invocationId,
            targetIdentity: context.targetIdentity,
            fingerprint: requestFingerprintSha256,
            scope: identityMode,
          });
        } catch (error) {
          await observeReadInvocation(options, {
            ...observation,
            disposition:
              error instanceof ReadInvocationConflictError ? "conflict" : "coordinator_failure",
          });
          const code = errorCode(error);
          return errorResultFrom(error, code);
        }
        await observeReadInvocation(options, {
          ...observation,
          disposition: acquisition.kind,
        });
        if (acquisition.kind === "replay") {
          return replayedReadCallToolResult(acquisition.value);
        }
        if (acquisition.kind === "join") {
          try {
            return replayedReadCallToolResult(await acquisition.completion);
          } catch (error) {
            return errorResultFrom(error, "READ_INVOCATION_RETRYABLE");
          }
        }

        try {
          // A transport cancellation ends only that caller's wait. The shared
          // scheduler/runtime timeout owns the physical read so a reconnecting
          // transport can join it while it is in flight. Completed results are
          // replayed only for explicit invocation ids: the host can reuse both
          // JSON-RPC and trace ids for a later read of externally changed state.
          // A physical mutation also separates new reads from older in-flight
          // snapshots through invalidateTransient().
          const result = await executeRead(
            acquisition.operationId,
            undefined,
            () => observeReadInvocation(options, { ...observation, disposition: "dispatch" }),
            invocationIdSha256,
          );
          acquisition.execution.finish(
            jsonReadInvocationValue(result),
            resultOutcome(result) === "succeeded",
          );
          return result;
        } catch (error) {
          try {
            acquisition.execution.fail(error);
          } catch {
            // A terminal transition error is already represented by the
            // coordinator result observed by any joined transport.
          }
          return errorResultFrom(error, "READ_INVOCATION_RETRYABLE");
        }
      }
      return executeGoalRead(lifecycle, fallbackOperationId, signal);
    }
    const fingerprint = mutationSemanticFingerprint(context, split.arguments);
    const serverRequestId = requestAttribution?.correlationId ?? options.correlationId;
    if (split.invocationId === undefined) {
      if (legacyCoordinator === undefined) {
        return errorResult("MUTATION_IDENTITY_UNAVAILABLE");
      }
      let acquisition: LegacyMutationAcquisition<MutationReplayJsonValue>;
      try {
        acquisition = await legacyCoordinator.acquire<MutationReplayJsonValue>({
          authorizationBinding: ownerBinding,
          semanticDigest: fingerprint,
          sessionId: legacySessionId,
          requestId: legacyRequestId,
          ...(context.retrySafeAfterUnknown === true ? { retrySafeAfterUnknown: true } : {}),
        });
      } catch (error) {
        const code = errorCode(error);
        await observeMutationReplay(options, {
          ...requestAttributionObservation(requestAttribution),
          surface,
          mcpToolName: name,
          identityMode: "legacy",
          invocationIdentityInputs,
          disposition: code?.startsWith("AMBIGUOUS_") ? "ambiguous" : "store_failure",
        });
        return withLegacyMutationDiagnostics(errorResultFrom(error, code), serverRequestId);
      }
      await observeMutationReplay(options, {
        ...requestAttributionObservation(requestAttribution),
        surface,
        mcpToolName: name,
        operationId: acquisition.operationId,
        identityMode: "legacy",
        invocationIdentityInputs,
        disposition: acquisition.kind,
      });
      const diagnose = (result: CallToolResult): CallToolResult =>
        result.isError === true
          ? withLegacyMutationDiagnostics(result, serverRequestId, acquisition.operationId)
          : result;
      if (acquisition.kind === "replay") {
        return diagnose(
          directGoalContext === undefined
            ? replayedCallToolResult(acquisition.value)
            : errorResult("DIRECT_GOAL_REPLAY_IS_NOT_FRESH_EXECUTION"),
        );
      }
      if (acquisition.kind === "outcome_unknown") {
        return diagnose(errorResult(`MUTATION_OUTCOME_UNKNOWN: ${acquisition.code}`));
      }
      if (acquisition.kind === "join") {
        const joined = mutationTerminalResult(await acquisition.completion);
        return diagnose(
          directGoalContext === undefined
            ? joined
            : errorResult("DIRECT_GOAL_JOIN_IS_NOT_FRESH_EXECUTION"),
        );
      }

      const execution = acquisition.execution;
      const lifecycle = await goalLifecycle(acquisition.operationId);
      if (lifecycle !== undefined) {
        try {
          await lifecycle.begin();
        } catch (error) {
          await execution
            .failBeforeDispatch("DIRECT_GOAL_PRECONDITION_FAILED")
            .catch(() => undefined);
          return diagnose(errorResultFrom(error, "DIRECT_GOAL_PRECONDITION_FAILED"));
        }
      }
      let nativeDispatchStarted = false;
      const observeLegacyBoundary = (
        disposition: "dispatch" | "request_signal_aborted" | "native_settled",
      ): void => {
        observeMutationReplay(options, {
          ...requestAttributionObservation(requestAttribution),
          surface,
          mcpToolName: name,
          operationId: acquisition.operationId,
          identityMode: "legacy",
          disposition,
          observedAtUnixMs: Date.now(),
          nativeDispatchStarted,
          requestSignalAborted: signal?.aborted === true,
          ...(disposition === "request_signal_aborted"
            ? { cancellationSource: "sdk_request_signal" as const }
            : {}),
        });
      };
      const onRequestAbort = (): void => observeLegacyBoundary("request_signal_aborted");
      signal?.addEventListener("abort", onRequestAbort, { once: true });
      if (signal?.aborted) onRequestAbort();
      try {
        const result = await dispatchToolCall(
          name,
          nativeArguments,
          signal,
          onNativeProgress,
          acquisition.operationId,
          true,
          beforeNativeDispatch(async () => {
            if (lifecycle !== undefined) await lifecycle.markDispatched();
            nativeDispatchStarted = true;
            observeLegacyBoundary("dispatch");
          }),
          context.targetIdentity,
          browserCallContext,
          split.invocationIdSha256,
          requestAttribution,
          browserStopOutcome,
        );
        if (!nativeDispatchStarted) {
          await execution.failBeforeDispatch("NATIVE_CALL_REJECTED_BEFORE_DISPATCH");
          await lifecycle?.abortBeforeDispatch().catch(() => undefined);
          return diagnose(result);
        }
        try {
          await execution.finish(jsonReplayValue(result));
        } catch (error) {
          await execution.outcomeUnknown("RESULT_COMMIT_FAILED").catch(() => undefined);
          await lifecycle?.markOutcomeUnknown().catch(() => undefined);
          return diagnose(errorResultFrom(error, "MUTATION_OUTCOME_UNKNOWN"));
        }
        if (lifecycle !== undefined) {
          try {
            await lifecycle.finalize(result);
          } catch (error) {
            return diagnose(errorResultFrom(error, "DIRECT_GOAL_EVIDENCE_COMMIT_FAILED"));
          }
        }
        return diagnose(result);
      } catch (error) {
        if (!nativeDispatchStarted) {
          await execution.failBeforeDispatch("NATIVE_PRE_DISPATCH_FAILED").catch(() => undefined);
          await lifecycle?.abortBeforeDispatch().catch(() => undefined);
          return diagnose(errorResultFrom(error, "MUTATION_NOT_DISPATCHED"));
        }
        const failureResult = authoritativeNativeFailureResult(error);
        if (failureResult !== undefined) {
          try {
            await execution.finish(jsonReplayValue(failureResult));
          } catch (commitError) {
            await execution.outcomeUnknown("RESULT_COMMIT_FAILED").catch(() => undefined);
            await lifecycle?.markOutcomeUnknown().catch(() => undefined);
            return diagnose(errorResultFrom(commitError, "MUTATION_OUTCOME_UNKNOWN"));
          }
          if (lifecycle !== undefined) {
            try {
              await lifecycle.finalize(failureResult);
            } catch (finalizeError) {
              return diagnose(errorResultFrom(finalizeError, "DIRECT_GOAL_EVIDENCE_COMMIT_FAILED"));
            }
          }
          return diagnose(failureResult);
        }
        await execution.outcomeUnknown("NATIVE_DISPATCH_FAILED").catch(() => undefined);
        await lifecycle?.markOutcomeUnknown().catch(() => undefined);
        return diagnose(errorResultFrom(error, "MUTATION_OUTCOME_UNKNOWN"));
      } finally {
        signal?.removeEventListener("abort", onRequestAbort);
        observeLegacyBoundary("native_settled");
      }
    }

    if (replayStore === undefined) return errorResult("MUTATION_REPLAY_STORE_UNAVAILABLE");
    let acquisition: MutationReplayAcquisition<MutationReplayJsonValue>;
    try {
      acquisition = await replayStore.acquire<MutationReplayJsonValue>({
        authorizationBinding: ownerBinding,
        idempotencyKey: split.invocationId,
        fingerprint,
      });
    } catch (error) {
      const conflict = errorCode(error) === "MUTATION_IDEMPOTENCY_CONFLICT";
      await observeMutationReplay(options, {
        ...requestAttributionObservation(requestAttribution),
        surface,
        mcpToolName: name,
        ...(split.invocationIdSha256 === undefined
          ? {}
          : { invocationIdSha256: split.invocationIdSha256 }),
        identityMode: "explicit",
        disposition: conflict ? "conflict" : "store_failure",
      });
      return errorResultFrom(error);
    }
    await observeMutationReplay(options, {
      ...requestAttributionObservation(requestAttribution),
      surface,
      mcpToolName: name,
      operationId: acquisition.operationId,
      ...(split.invocationIdSha256 === undefined
        ? {}
        : { invocationIdSha256: split.invocationIdSha256 }),
      identityMode: "explicit",
      disposition: acquisition.kind,
    });
    if (acquisition.kind === "replay") {
      return directGoalContext === undefined
        ? replayedCallToolResult(acquisition.value)
        : errorResult("DIRECT_GOAL_REPLAY_IS_NOT_FRESH_EXECUTION");
    }
    if (acquisition.kind === "outcome_unknown") {
      return errorResult(`MUTATION_OUTCOME_UNKNOWN: ${acquisition.code}`);
    }
    if (acquisition.kind === "join") {
      const joined = mutationTerminalResult(await acquisition.completion);
      return directGoalContext === undefined
        ? joined
        : errorResult("DIRECT_GOAL_JOIN_IS_NOT_FRESH_EXECUTION");
    }

    const execution = acquisition.execution;
    const lifecycle = await goalLifecycle(acquisition.operationId);
    if (lifecycle !== undefined) {
      try {
        await lifecycle.begin();
      } catch (error) {
        await execution
          .failBeforeDispatch("DIRECT_GOAL_PRECONDITION_FAILED")
          .catch(() => undefined);
        return errorResultFrom(error, "DIRECT_GOAL_PRECONDITION_FAILED");
      }
    }
    let nativeDispatchStarted = false;
    try {
      const result = await dispatchToolCall(
        name,
        nativeArguments,
        signal,
        onNativeProgress,
        acquisition.operationId,
        true,
        beforeNativeDispatch(async () => {
          // A new explicit ID cannot reclassify an unresolved legacy Chrome
          // mutation as fresh intent. Stop has its own cross-mode semantic fence.
          if (name === "chrome__control_chrome" && legacyCoordinator !== undefined) {
            let cursor: string | undefined;
            do {
              const page = await legacyCoordinator.readStatus({
                authorizationBinding: ownerBinding,
                semanticDigest: fingerprint,
                limit: 50,
                ...(cursor === undefined ? {} : { cursor }),
              });
              if (page.matches.some((match) => match.state !== "completed")) {
                throw new LegacyMutationAmbiguityError("AMBIGUOUS_LEGACY_MUTATION_COHORT");
              }
              cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
          }
          await execution.markDispatched();
          if (lifecycle !== undefined) await lifecycle.markDispatched();
          nativeDispatchStarted = true;
        }),
        context.targetIdentity,
        browserCallContext,
        split.invocationIdSha256,
        requestAttribution,
        browserStopOutcome,
      );
      if (!nativeDispatchStarted) {
        await execution.failBeforeDispatch("NATIVE_CALL_REJECTED_BEFORE_DISPATCH");
        await lifecycle?.abortBeforeDispatch().catch(() => undefined);
        return result;
      }
      try {
        await execution.complete(jsonReplayValue(result));
      } catch (error) {
        await execution.markOutcomeUnknown("RESULT_COMMIT_FAILED").catch(() => undefined);
        await lifecycle?.markOutcomeUnknown().catch(() => undefined);
        return errorResultFrom(error, "MUTATION_OUTCOME_UNKNOWN");
      }
      if (lifecycle !== undefined) {
        try {
          await lifecycle.finalize(result);
        } catch (error) {
          return errorResultFrom(error, "DIRECT_GOAL_EVIDENCE_COMMIT_FAILED");
        }
      }
      return result;
    } catch (error) {
      if (!nativeDispatchStarted) {
        await execution.failBeforeDispatch("NATIVE_PRE_DISPATCH_FAILED").catch(() => undefined);
        await lifecycle?.abortBeforeDispatch().catch(() => undefined);
        return errorResultFrom(error, "MUTATION_NOT_DISPATCHED");
      }
      const failureResult = authoritativeNativeFailureResult(error);
      if (failureResult !== undefined) {
        try {
          await execution.complete(jsonReplayValue(failureResult));
        } catch (commitError) {
          await execution.markOutcomeUnknown("RESULT_COMMIT_FAILED").catch(() => undefined);
          await lifecycle?.markOutcomeUnknown().catch(() => undefined);
          return errorResultFrom(commitError, "MUTATION_OUTCOME_UNKNOWN");
        }
        if (lifecycle !== undefined) {
          try {
            await lifecycle.finalize(failureResult);
          } catch (finalizeError) {
            return errorResultFrom(finalizeError, "DIRECT_GOAL_EVIDENCE_COMMIT_FAILED");
          }
        }
        return failureResult;
      }
      await execution.markOutcomeUnknown("NATIVE_DISPATCH_FAILED").catch(() => undefined);
      await lifecycle?.markOutcomeUnknown().catch(() => undefined);
      return errorResultFrom(error, "MUTATION_OUTCOME_UNKNOWN");
    }
  };

  const localDirectJobAdapter: DirectJobDispatchAdapter = {
    validate: resolveDirectJobTargetContract,
    dispatch: async (request): Promise<DirectJobDispatchOutcome> => {
      let directArguments: ReturnType<typeof splitDirectGoalContext>;
      try {
        directArguments = splitDirectGoalContext(request.arguments);
      } catch (error) {
        return {
          status: "failed",
          code: "DIRECT_JOB_GOAL_CONTEXT_INVALID",
          result: errorResultFrom(error, "DIRECT_GOAL_CONTEXT_INVALID"),
        };
      }
      const requestBytes = Buffer.byteLength(
        canonicalJson({ toolName: request.toolName, arguments: directArguments.arguments }),
        "utf8",
      );
      const result = await scheduler.withRequestContext(
        {
          ownerId: createHash("sha256").update(request.authorizationBinding, "utf8").digest("hex"),
          sessionId: request.workSessionBinding,
          requestBytes,
        },
        () =>
          dispatchWithMutationReplay(
            request.toolName,
            {
              ...directArguments.arguments,
              [OMNICODEX_INVOCATION_ID]: request.operationId,
            },
            { "omnicodex/invocationId": request.operationId },
            request.callerSessionId,
            request.operationId,
            request.signal,
            () => undefined,
            request.operationId,
            directArguments.goal,
            request.authorizationBinding,
            request.directGoalClaimantBinding,
            {
              ownerBinding: request.authorizationBinding,
              workSessionBinding: request.workSessionBinding,
              callerSessionId: request.callerSessionId,
              operationId: request.operationId,
            },
            {
              targetContract: request.targetContract,
              beforeNativeDispatch: request.beforeNativeDispatch,
            },
          ),
      );
      return directJobDispatchOutcome(result, request.signal);
    },
  };
  const directJobAdapter = options.directJobDispatchAdapter ?? localDirectJobAdapter;

  server.setRequestHandler("tools/call", async (request, context) => {
    const requestContext = {
      requestId: context.mcpReq.id,
      _meta: context.mcpReq._meta,
      signal: context.mcpReq.signal,
      sessionId: context.sessionId,
      sendNotification: context.mcpReq.notify,
    };
    const requestAttribution = options.resolveRequestAttribution?.(requestContext.requestId);
    const progressToken =
      request.params._meta?.progressToken ?? requestContext._meta?.progressToken;
    const rawArguments = withoutWorkSessionContext(
      request.params.name,
      request.params.arguments ?? {},
    );
    const legacyStatusRead =
      request.params.name === LEGACY_MUTATION_STATUS_TOOL ||
      (request.params.name === "call_native_tool" &&
        rawArguments.name === LEGACY_MUTATION_STATUS_TOOL);
    const requestInvocation = mutationArguments(
      rawArguments,
      request.params._meta ?? requestContext._meta,
    );
    const invocationIdSha256 = requestInvocation.ok
      ? requestInvocation.invocationIdSha256
      : undefined;
    let progressSequence = 0;
    await emitProgress(options, requestContext.sendNotification, {
      ...requestAttributionObservation(requestAttribution),
      surface,
      mcpToolName: request.params.name,
      phase: "started",
      invocationIdentityInputs: mutationIdentityInputPresence(
        rawArguments,
        request.params._meta ?? requestContext._meta,
      ),
      mcpArgumentsSha256: semanticDigest({
        present: request.params.arguments !== undefined,
        value: request.params.arguments,
      }),
      ...(invocationIdSha256 === undefined ? {} : { invocationIdSha256 }),
      progressToken,
      progress: 0,
      message: "Native call started",
    });
    let result: CallToolResult | undefined;
    let suppressResultDeliveryObservation = false;
    let deliveredInvocationIdSha256 = invocationIdSha256;
    // An explicit attachment destination is an approval target, not proof of
    // transport provenance. Never promote it into request attribution.
    let attachmentApprovalConversationUrl: string | undefined;
    let workSession: DirectJobWorkSessionBinding | undefined;
    if (options.resolveDurableWorkSessionBinding !== undefined && !legacyStatusRead) {
      try {
        workSession = await options.resolveDurableWorkSessionBinding();
      } catch (error) {
        result = errorResultFrom(error, "DURABLE_WORK_SESSION_UNAVAILABLE");
      }
    }
    const requestOperationId = nativeOperationId(
      operationNamespace,
      requestContext.sessionId,
      requestContext.requestId,
    );
    const browserCallContext: BrowserNativeCallContext = {
      ...(options.authorizationBinding === undefined
        ? {}
        : { ownerBinding: options.authorizationBinding }),
      ...browserCallerAttributionContext(requestAttribution),
      ...(workSession === undefined ? {} : { workSessionBinding: workSession.workSessionBinding }),
      ...((requestContext.sessionId ?? options.correlationId) === undefined
        ? {}
        : { callerSessionId: requestContext.sessionId ?? options.correlationId }),
      operationId: requestOperationId,
    };
    if (options.browserActivityCoordinator !== undefined && !legacyStatusRead) {
      await options.browserActivityCoordinator.observeActivityBoundary(browserCallContext);
    }
    const claimantBinding =
      workSession?.directGoalClaimantBinding ??
      options.correlationId ??
      requestContext.sessionId ??
      operationNamespace;
    const transportReadInvocation = automaticTransportReadInvocation(
      requestAttribution,
      workSession?.workSessionBinding,
    );
    if (request.params.name === OMNICODEX_SESSION_IDENTITY_TOOL) {
      let identityResultReplayed = false;
      if (options.resolveDurableWorkSessionBinding === undefined) {
        result = errorResult(
          "DURABLE_WORK_SESSION_UNAVAILABLE: session identity requires a server-owned durable work-session binding",
        );
      } else if (result === undefined) {
        if (workSession === undefined) {
          result = errorResult("DURABLE_WORK_SESSION_UNAVAILABLE");
        } else {
          try {
            const catalogRevision = (await registryForCall()).revision;
            const identityCacheKey = semanticDigest({
              catalogRevision,
              continuationToken: workSession.continuationToken,
              workSessionBinding: workSession.workSessionBinding,
            });
            const acquisition = readInvocationCoordinator.acquire<ReadInvocationJsonValue>({
              authorizationBinding: options.authorizationBinding ?? workSession.workSessionBinding,
              invocationId: identityCacheKey,
              targetIdentity: "omnicodex/session/identity",
              fingerprint: identityCacheKey,
              scope: "explicit",
            });
            if (acquisition.kind === "replay") {
              result = replayedReadCallToolResult(acquisition.value);
              identityResultReplayed = true;
            } else if (acquisition.kind === "join") {
              result = replayedReadCallToolResult(await acquisition.completion);
              identityResultReplayed = true;
            } else {
              result = sessionIdentityResult(workSession, catalogRevision);
              acquisition.execution.finish(jsonReadInvocationValue(result), true);
            }
          } catch (error) {
            result = errorResultFrom(error, "SESSION_IDENTITY_UNAVAILABLE");
          }
        }
      }
      const identityResult = result ?? errorResult("SESSION_IDENTITY_UNAVAILABLE");
      result = identityResult;
      if (!identityResultReplayed) {
        await observeExecution(options, {
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          surface,
          mcpToolName: request.params.name,
          operation: "native_call",
          targetNativeName: "session/identity",
          targetNamespace: "omnicodex",
          modelEffect: "none",
          stateEffect: "read",
          ...resultSummary(identityResult),
          outcome: resultOutcome(identityResult),
        });
      }
    } else if (legacyStatusRead) {
      if (
        options.legacyMutationCoordinator === undefined ||
        options.authorizationBinding === undefined
      ) {
        result = errorResult("LEGACY_STATUS_AUTHENTICATED_COORDINATOR_REQUIRED");
      } else {
        try {
          let statusArguments = rawArguments;
          if (request.params.name === "call_native_tool") {
            if (
              Object.keys(rawArguments).some(
                (key) => !["name", "arguments", "expectedCatalogRevision"].includes(key),
              ) ||
              !isObject(rawArguments.arguments) ||
              (rawArguments.expectedCatalogRevision !== undefined &&
                typeof rawArguments.expectedCatalogRevision !== "string")
            ) {
              throw new Error("LEGACY_STATUS_ARGUMENTS_INVALID");
            }
            if (
              typeof rawArguments.expectedCatalogRevision === "string" &&
              rawArguments.expectedCatalogRevision !== (await registryForCall()).revision
            ) {
              throw new Error("LEGACY_STATUS_CATALOG_CHANGED");
            }
            statusArguments = rawArguments.arguments;
          }
          result = await readLegacyMutationStatus({
            coordinator: options.legacyMutationCoordinator,
            authorizationBinding: options.authorizationBinding,
            arguments: statusArguments,
            fingerprint: async (toolName, originalArguments) => {
              const original = splitDirectGoalContext(
                withoutWorkSessionContext(toolName, originalArguments),
              );
              const split = mutationArguments(original.arguments, undefined);
              if (!split.ok || split.invocationId !== undefined)
                throw new Error("LEGACY_STATUS_LEGACY_REQUEST_REQUIRED");
              const context = await callStateContext(toolName, split.arguments);
              if (context.stateEffect !== "mutate")
                throw new Error("LEGACY_STATUS_MUTATION_REQUEST_REQUIRED");
              return mutationSemanticFingerprint(context, split.arguments);
            },
          });
        } catch (error) {
          // Arbitrary validator/runtime messages can embed arguments or credentials.
          // This status-only endpoint returns fixed error codes instead.
          result = errorResult(
            error instanceof Error && /^LEGACY_STATUS_[A-Z_]+$/u.test(error.message)
              ? error.message
              : "LEGACY_STATUS_QUERY_UNAVAILABLE",
          );
        }
      }
      await observeExecution(options, {
        ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
        surface,
        mcpToolName: request.params.name,
        operation: "native_call",
        targetNativeName: "legacy-mutation/status",
        targetNamespace: "omnicodex",
        modelEffect: "none",
        stateEffect: "read",
        ...resultSummary(result),
        outcome: resultOutcome(result),
      });
    } else if (request.params.name === PROTECTED_RESULT_READ_TOOL) {
      if (options.readProtectedResult === undefined) {
        result = errorResult(`Tool ${request.params.name} is unavailable`);
      } else if (result === undefined) {
        try {
          result = protectedResultReadChunkResult(
            await options.readProtectedResult(protectedResultReadRequest(rawArguments)),
          );
        } catch (error) {
          result = errorResultFrom(error, "PROTECTED_RESULT_READ_FAILED");
        }
      }
      const readResult = result ?? errorResult("PROTECTED_RESULT_READ_FAILED");
      result = readResult;
      await observeExecution(options, {
        ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
        surface,
        mcpToolName: request.params.name,
        operation: "native_call",
        targetNativeName: "result/read",
        targetNamespace: "omnicodex",
        modelEffect: "none",
        stateEffect: "read",
        ...resultSummary(readResult),
        outcome: resultOutcome(readResult),
      });
    } else if (request.params.name === OMNICODEX_ATTACH_LOCAL_FILE_TOOL) {
      const materializeLocalFile = options.materializeLocalFile;
      let attachmentArguments: Record<string, unknown> = rawArguments;
      let explicitAttachmentGoalContext: DirectGoalInvocationContext | undefined;
      let attachmentRequestInvocation = requestInvocation;
      if (result === undefined) {
        try {
          const split = splitDirectGoalContext(rawArguments);
          attachmentArguments = split.arguments;
          explicitAttachmentGoalContext = split.goal;
          attachmentRequestInvocation = mutationArguments(
            attachmentArguments,
            request.params._meta ?? requestContext._meta,
          );
        } catch (error) {
          result = errorResultFrom(error, "DIRECT_GOAL_CONTEXT_INVALID");
        }
      }
      const exactReadInvocation =
        attachmentRequestInvocation.ok &&
        attachmentRequestInvocation.invocationId !== undefined &&
        attachmentRequestInvocation.invocationIdSha256 !== undefined
          ? {
              invocationId: attachmentRequestInvocation.invocationId,
              invocationIdSha256: attachmentRequestInvocation.invocationIdSha256,
              identityMode: "explicit" as const,
            }
          : transportReadInvocation;
      deliveredInvocationIdSha256 =
        exactReadInvocation?.invocationIdSha256 ?? deliveredInvocationIdSha256;
      if (!attachmentRequestInvocation.ok) {
        result = errorResult(attachmentRequestInvocation.message);
      } else if (materializeLocalFile === undefined) {
        result = errorResult(`Tool ${request.params.name} is unavailable`);
      }
      if (result === undefined) {
        try {
          attachmentApprovalConversationUrl = attachmentApprovalRoute(
            requestAttribution?.chatGptConversationUrl,
            attachmentArguments.chatGptConversationUrl,
          );
        } catch (error) {
          result = errorResultFrom(error, "LOCAL_FILE_ATTACHMENT_APPROVAL_TARGET_INVALID");
        }
      }
      if (result === undefined && materializeLocalFile !== undefined) {
        const attachmentGoal = async (
          operationId: string,
          stateEffect: "read" | "mutate",
          recoverDispatched = false,
        ): Promise<DirectGoalExecutionLifecycle | undefined> => {
          if (
            options.directGoalStore === undefined ||
            options.authorizationBinding === undefined ||
            workSession === undefined
          )
            return undefined;
          const authorizationBinding = directGoalOwnerBinding(
            options.authorizationBinding,
            workSession.workSessionBinding,
          );
          const targetIdentity = "resource/attach-local-file";
          const pendingExecution = () =>
            options.directGoalStore?.resolvePendingExecution({
              authorizationBinding,
              claimantBinding,
              toolName: request.params.name,
              resourceDigest: directGoalResourceDigest(
                nativeExecutionOrderingFromArguments(attachmentArguments),
                targetIdentity,
              ),
              stateEffect,
              modelEffect: "none",
              ...(recoverDispatched ? { operationId } : {}),
            });
          // Recovering an already-dispatched immutable attachment must bind to
          // that original operation's server-side Goal record. A newly supplied
          // Goal action token belongs to the current delivery/read step and must
          // not be retrofitted onto the historical mutation operation.
          const context = recoverDispatched
            ? await pendingExecution()
            : (explicitAttachmentGoalContext ?? (await pendingExecution()));
          if (context === undefined) return undefined;
          return new DirectGoalExecutionLifecycle(options.directGoalStore, {
            authorizationBinding,
            claimantBinding,
            context,
            operationId,
            toolName: request.params.name,
            targetIdentity,
            stateEffect,
            modelEffect: "none",
            arguments: attachmentArguments,
          });
        };
        const recordAttachmentResultRead = async (
          value: CallToolResult,
          originalOperationId: string,
        ): Promise<CallToolResult> => {
          // The immutable replay record proves the result of this exact
          // dispatched operation even if its separate Goal commit failed.
          const recovery = await attachmentGoal(originalOperationId, "mutate", true);
          if (recovery !== undefined) {
            await recovery.finalize(value);
            return value;
          }
          // A retry reads the immutable snapshot identified by this exact
          // owner/session/path/invocation. It is evidence of result retrieval,
          // never a second file materialization or a fresh mutation receipt.
          const lifecycle = await attachmentGoal(requestOperationId, "read");
          if (lifecycle === undefined) return value;
          await lifecycle.begin();
          try {
            await lifecycle.markDispatched();
            await lifecycle.finalize(value);
          } catch (error) {
            if (lifecycle.dispatched) await lifecycle.markOutcomeUnknown().catch(() => undefined);
            else await lifecycle.abortBeforeDispatch().catch(() => undefined);
            throw error;
          }
          return value;
        };
        const executeAttachment = async (): Promise<CallToolResult> => {
          if (
            typeof attachmentArguments.path !== "string" ||
            attachmentArguments.path.trim().length === 0
          ) {
            throw new Error("Local file path must be a non-empty absolute path");
          }
          return await materializeLocalFile(attachmentArguments.path, {
            ...(requestContext.sessionId === undefined
              ? {}
              : { sessionId: requestContext.sessionId }),
            ...(workSession === undefined ? {} : { workSession }),
          });
        };
        if (
          options.authorizationBinding !== undefined &&
          options.mutationReplayStore !== undefined &&
          exactReadInvocation?.identityMode === "explicit"
        ) {
          // An attachment is an immutable snapshot. Keep its explicit request
          // identity across approval retries and runtime restarts; a transport
          // trace cannot distinguish a retry from a new snapshot of this path.
          const targetIdentity = "resource/attach-local-file";
          const fingerprint = semanticDigest({
            contract: "omnicodex-local-file-attachment-v1",
            targetIdentity,
            workSessionBinding: workSession?.workSessionBinding,
            arguments: {
              path: attachmentArguments.path,
              ...(attachmentArguments.chatGptConversationUrl === undefined
                ? {}
                : { chatGptConversationUrl: attachmentApprovalConversationUrl }),
            },
          });
          const observation = {
            ...requestAttributionObservation(requestAttribution),
            surface,
            mcpToolName: request.params.name,
            invocationIdSha256: exactReadInvocation.invocationIdSha256,
            identityMode: "explicit" as const,
            targetIdentitySha256: createHash("sha256").update(targetIdentity, "utf8").digest("hex"),
            resourceDigestSha256: semanticDigest({
              targetIdentity,
              path: attachmentArguments.path,
            }),
            requestFingerprintSha256: fingerprint,
          };
          let dispatched = false;
          let committed = false;
          let lifecycle: DirectGoalExecutionLifecycle | undefined;
          let acquisition: MutationReplayAcquisition<MutationReplayJsonValue> | undefined;
          try {
            acquisition = await options.mutationReplayStore.acquire({
              authorizationBinding: options.authorizationBinding,
              idempotencyKey: exactReadInvocation.invocationId,
              fingerprint,
            });
            await observeReadInvocation(options, {
              ...observation,
              disposition:
                acquisition.kind === "outcome_unknown" ? "coordinator_failure" : acquisition.kind,
            });
            suppressResultDeliveryObservation = acquisition.kind !== "execute";
            if (acquisition.kind === "replay") {
              committed = true;
              result = await recordAttachmentResultRead(
                replayedCallToolResult(acquisition.value),
                acquisition.operationId,
              );
            } else if (acquisition.kind === "join") {
              const terminal = await acquisition.completion;
              committed = terminal.kind === "completed";
              result =
                terminal.kind === "completed"
                  ? await recordAttachmentResultRead(
                      mutationTerminalResult(terminal),
                      acquisition.operationId,
                    )
                  : mutationTerminalResult(terminal);
            } else if (acquisition.kind === "outcome_unknown") {
              result = errorResult(`LOCAL_FILE_ATTACHMENT_OUTCOME_UNKNOWN: ${acquisition.code}`);
            } else {
              lifecycle = await attachmentGoal(acquisition.operationId, "mutate");
              await lifecycle?.begin();
              await acquisition.execution.markDispatched();
              await lifecycle?.markDispatched();
              dispatched = true;
              await observeReadInvocation(options, { ...observation, disposition: "dispatch" });
              try {
                result = await executeAttachment();
              } catch (error) {
                result = errorResultFrom(error, "LOCAL_FILE_ATTACHMENT_FAILED");
              }
              await acquisition.execution.complete(jsonReplayValue(result));
              committed = true;
              await lifecycle?.finalize(result);
            }
          } catch (error) {
            suppressResultDeliveryObservation = !dispatched;
            await observeReadInvocation(options, {
              ...observation,
              disposition:
                errorCode(error) === "MUTATION_IDEMPOTENCY_CONFLICT"
                  ? "conflict"
                  : "coordinator_failure",
            });
            if (acquisition?.kind === "execute") {
              if (dispatched && !committed) {
                await acquisition.execution
                  .markOutcomeUnknown("ATTACHMENT_RESULT_UNAVAILABLE")
                  .catch(() => undefined);
              } else if (!dispatched) {
                await acquisition.execution
                  .failBeforeDispatch("ATTACHMENT_NOT_DISPATCHED")
                  .catch(() => undefined);
              }
            }
            if (lifecycle?.dispatched) await lifecycle.markOutcomeUnknown().catch(() => undefined);
            else await lifecycle?.abortBeforeDispatch().catch(() => undefined);
            result = errorResultFrom(
              error,
              committed
                ? "DIRECT_GOAL_EVIDENCE_COMMIT_FAILED"
                : dispatched
                  ? "LOCAL_FILE_ATTACHMENT_OUTCOME_UNKNOWN"
                  : "LOCAL_FILE_ATTACHMENT_FAILED",
            );
          }
        } else if (
          options.authorizationBinding === undefined ||
          exactReadInvocation === undefined
        ) {
          try {
            result = await executeAttachment();
          } catch (error) {
            result = errorResultFrom(error, "LOCAL_FILE_ATTACHMENT_FAILED");
          }
        } else {
          const targetIdentity = "resource/attach-local-file";
          const requestFingerprintSha256 = semanticDigest({
            contract: "omnicodex-local-file-attachment-v1",
            targetIdentity,
            arguments: {
              path: attachmentArguments.path,
              ...(attachmentArguments.chatGptConversationUrl === undefined
                ? {}
                : { chatGptConversationUrl: attachmentApprovalConversationUrl }),
            },
          });
          const targetIdentitySha256 = createHash("sha256")
            .update(targetIdentity, "utf8")
            .digest("hex");
          const resourceDigestSha256 = semanticDigest({
            targetIdentity,
            path: attachmentArguments.path,
          });
          const observation = {
            ...requestAttributionObservation(requestAttribution),
            surface,
            mcpToolName: request.params.name,
            invocationIdSha256: exactReadInvocation.invocationIdSha256,
            identityMode: exactReadInvocation.identityMode,
            targetIdentitySha256,
            resourceDigestSha256,
            requestFingerprintSha256,
          } as const;
          let acquisition: ReadInvocationAcquisition<ReadInvocationJsonValue> | undefined;
          try {
            acquisition = readInvocationCoordinator.acquire<ReadInvocationJsonValue>({
              authorizationBinding: options.authorizationBinding,
              invocationId: exactReadInvocation.invocationId,
              targetIdentity,
              fingerprint: requestFingerprintSha256,
              scope: exactReadInvocation.identityMode,
            });
            await observeReadInvocation(options, {
              ...observation,
              disposition: acquisition.kind,
            });
          } catch (error) {
            await observeReadInvocation(options, {
              ...observation,
              disposition:
                error instanceof ReadInvocationConflictError ? "conflict" : "coordinator_failure",
            });
            result = errorResultFrom(error, errorCode(error));
            suppressResultDeliveryObservation = true;
          }
          if (result === undefined && acquisition?.kind === "replay") {
            result = replayedReadCallToolResult(acquisition.value);
            suppressResultDeliveryObservation = true;
          } else if (result === undefined && acquisition?.kind === "join") {
            suppressResultDeliveryObservation = true;
            try {
              result = replayedReadCallToolResult(await acquisition.completion);
            } catch (error) {
              result = errorResultFrom(error, "READ_INVOCATION_RETRYABLE");
            }
          } else if (result === undefined && acquisition?.kind === "execute") {
            await observeReadInvocation(options, { ...observation, disposition: "dispatch" });
            try {
              result = await executeAttachment();
              acquisition.execution.finish(
                jsonReadInvocationValue(result),
                resultOutcome(result) === "succeeded",
              );
            } catch (error) {
              try {
                acquisition.execution.fail(error);
              } catch {
                // The shared coordinator has already published a terminal state.
              }
              result = errorResultFrom(error, "LOCAL_FILE_ATTACHMENT_FAILED");
            }
          }
        }
      }
      const attachmentResult = result ?? errorResult("LOCAL_FILE_ATTACHMENT_FAILED");
      result = attachmentResult;
      if (!suppressResultDeliveryObservation) {
        await observeExecution(options, {
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          ...(deliveredInvocationIdSha256 === undefined
            ? {}
            : { invocationIdSha256: deliveredInvocationIdSha256 }),
          surface,
          mcpToolName: request.params.name,
          operation: "native_call",
          targetNativeName: "resource/attach-local-file",
          targetNamespace: "omnicodex",
          modelEffect: "none",
          stateEffect: "mutate",
          ...resultSummary(attachmentResult),
          outcome: resultOutcome(attachmentResult),
        });
      }
    } else if (isDirectJobTool(request.params.name)) {
      if (
        options.directJobManager === undefined ||
        options.authorizationBinding === undefined ||
        options.correlationId === undefined ||
        options.resolveDurableWorkSessionBinding === undefined
      ) {
        result = errorResult(`Tool ${request.params.name} is not advertised on this surface`);
      } else if (result === undefined) {
        try {
          if (workSession === undefined) throw new Error("DURABLE_WORK_SESSION_UNAVAILABLE");
          const jobContext: DirectJobInvocationContext = {
            authorizationBinding: options.authorizationBinding,
            callerSessionId: options.correlationId,
            workSessionBinding: workSession.workSessionBinding,
            directGoalClaimantBinding: workSession.directGoalClaimantBinding,
            directJobOwnerBinding: workSession.directJobOwnerBinding,
          };
          result = await callDirectJobTool(
            options.directJobManager,
            directJobAdapter,
            request.params.name,
            rawArguments,
            jobContext,
          );
        } catch (error) {
          result = errorResultFrom(error);
        }
      }
    } else if (isDirectScheduleTool(request.params.name)) {
      if (
        options.directScheduleManager === undefined ||
        options.directJobManager === undefined ||
        options.authorizationBinding === undefined ||
        options.correlationId === undefined ||
        options.resolveDurableWorkSessionBinding === undefined
      ) {
        result = errorResult(`Tool ${request.params.name} is not advertised on this surface`);
      } else if (result === undefined) {
        try {
          if (workSession === undefined) throw new Error("DURABLE_WORK_SESSION_UNAVAILABLE");
          const scheduleContext: DirectScheduleInvocationContext = {
            authorizationBinding: options.authorizationBinding,
            callerSessionId: options.correlationId,
            workSessionBinding: workSession.workSessionBinding,
            directGoalClaimantBinding: workSession.directGoalClaimantBinding,
            directJobOwnerBinding: workSession.directJobOwnerBinding,
            directScheduleOwnerBinding: workSession.directJobOwnerBinding,
          };
          result = await callDirectScheduleTool(
            options.directScheduleManager,
            directJobAdapter,
            request.params.name,
            rawArguments,
            scheduleContext,
          );
        } catch (error) {
          result = errorResultFrom(error);
        }
      }
    } else if (isDirectGoalTool(request.params.name)) {
      if (options.directGoalStore === undefined || options.authorizationBinding === undefined) {
        result = errorResult(`Tool ${request.params.name} is not advertised on this surface`);
      } else if (result === undefined) {
        try {
          if (workSession === undefined) throw new Error("DURABLE_WORK_SESSION_UNAVAILABLE");
          let goalOwner = directGoalOwnerBinding(
            options.authorizationBinding,
            workSession.workSessionBinding,
          );
          let goalManagementOwners: readonly string[] = [goalOwner];
          let goalArguments = rawArguments;
          if (
            request.params.name === "omnicodex__goal_list" ||
            (request.params.name !== "omnicodex__goal_create" &&
              (typeof rawArguments.goalId === "string" ||
                typeof rawArguments.conversationUrl === "string"))
          ) {
            const bindings = new Set([
              workSession.workSessionBinding,
              ...((await options.listAuthorizedGoalWorkSessionBindings?.()) ?? []),
            ]);
            const principal = options.authorizationBinding;
            goalManagementOwners = [...bindings].map((binding) =>
              directGoalOwnerBinding(principal, binding),
            );
            if (request.params.name !== "omnicodex__goal_list") {
              const target = await options.directGoalStore.resolveManagementTarget(
                goalManagementOwners,
                {
                  ...(typeof rawArguments.goalId === "string"
                    ? { goalId: rawArguments.goalId }
                    : {}),
                  ...(typeof rawArguments.conversationUrl === "string"
                    ? { conversationUrl: rawArguments.conversationUrl }
                    : {}),
                },
              );
              if (target === undefined) throw new Error("DIRECT_GOAL_NOT_FOUND");
              goalOwner = target.authorizationBinding;
              goalArguments = { ...rawArguments, goalId: target.goalId };
            }
          }
          const goalResult = await callDirectGoalTool(
            options.directGoalStore,
            request.params.name,
            goalArguments,
            goalOwner,
            claimantBinding,
            goalManagementOwners,
          );
          result =
            options.protectResult === undefined
              ? goalResult
              : directGoalResultWithInlineState(request.params.name, goalResult);
        } catch (error) {
          result = errorResultFrom(error);
        }
      }
    } else {
      const browserStopOutcome: BrowserActivityStopOutcome | undefined =
        request.params.name === OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL ? {} : undefined;
      if (
        request.params.name === OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL &&
        Object.keys(request.params.arguments ?? {}).length !== 0
      ) {
        // Validate the original wire arguments, before legacy context stripping
        // or mutation/Goal envelopes can hide a caller-selected identifier.
        result = errorResult("BROWSER_ACTIVITY_STOP_ARGUMENTS_MUST_BE_EMPTY");
      }
      let directArguments: ReturnType<typeof splitDirectGoalContext>;
      try {
        directArguments = splitDirectGoalContext(rawArguments);
      } catch (error) {
        result = errorResultFrom(error, "DIRECT_GOAL_CONTEXT_INVALID");
        directArguments = { arguments: {} };
      }
      if (result === undefined) {
        result = await dispatchWithMutationReplay(
          request.params.name,
          directArguments.arguments,
          request.params._meta ?? requestContext._meta,
          requestContext.sessionId ?? options.correlationId ?? operationNamespace,
          requestContext.requestId,
          requestContext.signal,
          async (event) => {
            progressSequence += 1;
            await emitProgress(options, requestContext.sendNotification, {
              ...requestAttributionObservation(requestAttribution),
              surface,
              mcpToolName: request.params.name,
              phase: "native",
              ...(invocationIdSha256 === undefined ? {} : { invocationIdSha256 }),
              progressToken,
              progress: progressSequence,
              message: event.message,
            });
          },
          requestOperationId,
          directArguments.goal,
          options.authorizationBinding,
          claimantBinding,
          browserCallContext,
          undefined,
          transportReadInvocation,
          requestAttributionObservation(requestAttribution),
          browserStopOutcome,
        );
        if (browserStopOutcome?.execution !== undefined) {
          if (result.isError !== true && browserStopOutcome.cleanupSucceeded === true) {
            try {
              await browserStopOutcome.execution.finish(null);
            } catch (error) {
              await browserStopOutcome.execution
                .outcomeUnknown("BROWSER_ACTIVITY_STOP_RESULT_COMMIT_FAILED")
                .catch(() => undefined);
              result = errorResultFrom(error, "MUTATION_OUTCOME_UNKNOWN");
            }
          } else {
            // Cancellation can end the caller's wait before physical cleanup
            // settles. Never promote a later completion into automatic replay.
            await browserStopOutcome.execution
              .outcomeUnknown("BROWSER_ACTIVITY_STOP_OUTCOME_UNKNOWN")
              .catch(() => undefined);
          }
        }
      }
    }
    if (result === undefined) result = errorResult("OMNICODEX_CALL_ROUTING_FAILED");
    result = publicToolResult(result);
    const protectedResult =
      options.protectResult === undefined || legacyStatusRead
        ? result
        : await options.protectResult(result, {
            ...(requestContext.sessionId === undefined
              ? {}
              : { sessionId: requestContext.sessionId }),
            ...(workSession === undefined ? {} : { workSession }),
          });
    const deliveredWithoutActivity =
      workSession === undefined ||
      request.params.name === OMNICODEX_SESSION_IDENTITY_TOOL ||
      legacyStatusRead
        ? protectedResult
        : withWorkSessionMetadata(protectedResult, workSession);
    const delivered = deliveredWithoutActivity;
    const receiptMeta = isObject(delivered._meta?.omnicodex)
      ? delivered._meta.omnicodex.protectedResult
      : undefined;
    const errorReceipt =
      delivered.isError === true &&
      isObject(receiptMeta) &&
      receiptMeta.ownerBound === true &&
      typeof receiptMeta.resourceId === "string" &&
      /^[A-Za-z0-9_-]{43}$/u.test(receiptMeta.resourceId) &&
      typeof receiptMeta.digest === "string" &&
      /^[A-Za-z0-9_-]{43}$/u.test(receiptMeta.digest)
        ? {
            protectedErrorResourceId: receiptMeta.resourceId,
            protectedErrorDigest: receiptMeta.digest,
          }
        : {};
    const protectedResourceLinks = materializableResourceLinkCount(delivered);
    const approvalConversationUrl =
      attachmentApprovalConversationUrl ?? requestAttribution?.chatGptConversationUrl;
    if (protectedResourceLinks > 0 && options.prepareProtectedResultDelivery !== undefined) {
      try {
        const preparation = options.prepareProtectedResultDelivery({
          surface,
          mcpToolName: request.params.name,
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          ...(approvalConversationUrl === undefined
            ? {}
            : { chatGptConversationUrl: approvalConversationUrl }),
        });
        void Promise.resolve(preparation).catch(() => undefined);
      } catch {
        // Oracle preparation is independent post-tool orchestration. The
        // authoritative tool result must still be delivered exactly once.
      }
    }
    // Result observation is telemetry and post-delivery orchestration. It must
    // never hold the MCP response open: ChatGPT retries a still-pending tool
    // call, which can duplicate even read-only attachment materialization.
    if (!suppressResultDeliveryObservation) {
      observeWithoutBlocking(() =>
        options.observeResultDelivery?.({
          ...requestAttributionObservation(requestAttribution),
          ...(approvalConversationUrl === undefined
            ? {}
            : {
                chatGptConversationUrl: approvalConversationUrl,
                approvalTargetSource:
                  requestAttribution?.chatGptConversationUrl === undefined
                    ? ("tool_argument" as const)
                    : ("request_metadata" as const),
              }),
          ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
          surface,
          mcpToolName: request.params.name,
          ...(deliveredInvocationIdSha256 === undefined
            ? {}
            : { invocationIdSha256: deliveredInvocationIdSha256 }),
          contentTypes: delivered.content.map((item) => item.type).join(","),
          deliveredByteLength: Buffer.byteLength(JSON.stringify(delivered), "utf8"),
          nativeBrowserPreviewDetached: hasDetachedNativeBrowserPreview(delivered),
          ...errorReceipt,
          // ChatGPT asks for file-materialization approval for every returned
          // resource link, including native Codex/app/plugin attachments that do
          // not carry OmniCodex's private ownerBound metadata. Counting only the
          // latter made the Oracle watcher miss the exact popup it exists to
          // approve.
          protectedResourceLinks,
        }),
      );
    }
    await emitProgress(options, requestContext.sendNotification, {
      ...requestAttributionObservation(requestAttribution),
      surface,
      mcpToolName: request.params.name,
      phase: "completed",
      ...(deliveredInvocationIdSha256 === undefined
        ? {}
        : { invocationIdSha256: deliveredInvocationIdSha256 }),
      progressToken,
      progress: progressSequence + 1,
      total: progressSequence + 1,
      message: "Native call completed",
    });
    return delivered as unknown as ModernCallToolResult;
  });

  return {
    server,
    catalog,
    executor,
    appServerMethodCatalog,
    appServerMethodExecutor,
    responsesToolCatalog,
    responsesToolExecutor,
    scheduler,
    directJobDispatchAdapter: directJobAdapter,
    classifyToolCall: async (name, args) => {
      if (
        name === OMNICODEX_SESSION_IDENTITY_TOOL ||
        name === OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL ||
        name === PROTECTED_RESULT_READ_TOOL ||
        name === LEGACY_MUTATION_STATUS_TOOL ||
        name === OMNICODEX_ATTACH_LOCAL_FILE_TOOL
      ) {
        return "non_model";
      }
      if (isDirectJobTool(name)) return "non_model";
      if (isDirectScheduleTool(name)) return "non_model";
      if (isDirectGoalTool(name)) return "non_model";
      const registry = await registryForCall();
      if (name === "search_native_tools") return "non_model";
      if (isBrowserNativeTool(name) && options.browserNativeExecutor !== undefined) {
        return "non_model";
      }
      const codexAppTool = codexAppHostToolExecutor.descriptor(name);
      if (codexAppTool !== undefined) {
        return codexAppTool.modelEffect === "model" ? "model" : "non_model";
      }
      if (name === "app_server_rpc") {
        return typeof args.method === "string" && isModelInvokingAppServerMethod(args.method)
          ? "model"
          : "non_model";
      }
      if (name === "call_native_tool") {
        if (args.name === "search_native_tools") return "non_model";
        const entry = genericTarget(
          registry,
          args,
          hostCatalogForRegistry(registry),
          options.browserNativeExecutor !== undefined,
        );
        return entry?.modelEffect === "model"
          ? "model"
          : entry?.modelEffect === "none"
            ? "non_model"
            : "unknown";
      }
      const entry = registry.entries.find((candidate) => candidate.exposedName === name);
      return entry?.modelEffect === "model"
        ? "model"
        : entry?.modelEffect === "none"
          ? "non_model"
          : "unknown";
    },
    refresh: async () => {
      await refreshRegistry();
    },
  };
}

export function materializableResourceLinkCount(result: CallToolResult): number {
  return result.content.filter((item) => item.type === "resource_link").length;
}

function hasDetachedNativeBrowserPreview(result: CallToolResult): boolean {
  const nativeBrowserPreview = objectValue(
    objectValue(objectValue(result._meta).omnicodex).nativeBrowserPreview,
  );
  return (
    nativeBrowserPreview.inline === false && nativeBrowserPreview.exactResultAvailable === true
  );
}

/**
 * Dynamic Goals retain every exact execution receipt in the durable store.
 * Return the state needed for the next decision without replaying that entire
 * ledger into every model turn.
 */
export function directGoalResultWithInlineState(
  toolName: string,
  result: CallToolResult,
): CallToolResult {
  if (result.isError === true) return result;
  const structured = objectValue(result.structuredContent);
  if (toolName === "omnicodex__goal_list") {
    if (!Array.isArray(structured.goals)) return result;
    const goals = structured.goals.map((goal) => compactDirectGoalSummary(objectValue(goal)));
    if (goals.some((goal) => goal === undefined)) return result;
    return compactDirectGoalResult(
      toolName,
      {
        ...structured,
        goals,
      },
      result._meta,
    );
  }
  if (toolName === "omnicodex__goal_claim_next_step") {
    const goal = compactDirectGoalView(objectValue(structured.goal));
    const step = compactDirectGoalClaimStep(objectValue(structured.step));
    if (goal === undefined || step === undefined) return result;
    return compactDirectGoalResult(
      toolName,
      {
        ...structured,
        goal,
        step,
      },
      result._meta,
    );
  }
  if (
    toolName !== "omnicodex__goal_create" &&
    toolName !== "omnicodex__goal_get" &&
    toolName !== "omnicodex__goal_complete" &&
    toolName !== "omnicodex__goal_update"
  )
    return result;
  const goal = compactDirectGoalView(structured);
  if (goal === undefined) return result;
  return compactDirectGoalResult(toolName, goal, result._meta);
}

function compactDirectGoalView(goal: Record<string, unknown>): Record<string, unknown> | undefined {
  if (
    typeof goal.id !== "string" ||
    typeof goal.state !== "string" ||
    typeof goal.revision !== "number" ||
    !Array.isArray(goal.steps)
  )
    return undefined;
  const steps = goal.steps.map(objectValue);
  const stateCounts = directGoalStateCounts(steps);
  const unresolvedSteps = steps.filter((step) => step.state !== "completed");
  const unresolved = unresolvedSteps
    .toSorted(
      (left, right) =>
        unresolvedGoalStepPriority(left.state) - unresolvedGoalStepPriority(right.state),
    )
    .slice(0, 32)
    .map((step) => {
      const reservation = objectValue(step.reservation);
      return {
        id: step.id,
        state: step.state,
        mode: step.mode,
        description: boundedInlineGoalText(step.description, 512),
        ...(typeof reservation.operationId === "string"
          ? {
              reservation: {
                operationId: reservation.operationId,
                state: reservation.state,
                toolName: reservation.toolName,
                stateEffect: reservation.stateEffect,
                modelEffect: reservation.modelEffect,
              },
            }
          : {}),
      };
    });
  const continuation = objectValue(goal.continuation);
  const draft = objectValue(continuation.draft);
  const completed = steps.filter((step) => step.state === "completed");
  const compactGoal = {
    id: goal.id,
    state: goal.state,
    revision: goal.revision,
    executionMode: goal.executionMode,
    objective: boundedInlineGoalText(goal.objective, 4_096),
    createdAtUnixMs: goal.createdAtUnixMs,
    updatedAtUnixMs: goal.updatedAtUnixMs,
    completedAtUnixMs: goal.completedAtUnixMs,
    blockedAtUnixMs: goal.blockedAtUnixMs,
    blockedReason: boundedInlineGoalText(goal.blockedReason, 2_048),
    stepCount: steps.length,
    stateCounts,
    steps: unresolved,
    unresolvedOmitted: Math.max(0, unresolvedSteps.length - unresolved.length),
    recentCompleted: completed.slice(-8).map((step) => ({
      id: step.id,
      state: step.state,
      mode: step.mode,
      description: boundedInlineGoalText(step.description, 256),
      receiptCount: Array.isArray(step.receipts) ? step.receipts.length : 0,
    })),
    ...(continuation.enabled === true
      ? {
          continuation: {
            enabled: true,
            conversationUrl: continuation.conversationUrl,
            settledMessageId: continuation.settledMessageId,
            draft:
              typeof draft.state === "string"
                ? {
                    state: draft.state,
                    afterMessageId: draft.afterMessageId,
                    transport: draft.transport,
                  }
                : undefined,
          },
        }
      : {}),
  };
  return compactGoal;
}

function compactDirectGoalSummary(
  goal: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    typeof goal.id !== "string" ||
    typeof goal.state !== "string" ||
    typeof goal.revision !== "number" ||
    !Array.isArray(goal.steps)
  )
    return undefined;
  const steps = goal.steps.map(objectValue);
  const continuation = objectValue(goal.continuation);
  const draft = objectValue(continuation.draft);
  return {
    id: goal.id,
    state: goal.state,
    revision: goal.revision,
    executionMode: goal.executionMode,
    objective: boundedInlineGoalText(goal.objective, 1_024),
    createdAtUnixMs: goal.createdAtUnixMs,
    updatedAtUnixMs: goal.updatedAtUnixMs,
    completedAtUnixMs: goal.completedAtUnixMs,
    blockedAtUnixMs: goal.blockedAtUnixMs,
    blockedReason: boundedInlineGoalText(goal.blockedReason, 512),
    stepCount: steps.length,
    stateCounts: directGoalStateCounts(steps),
    ...(continuation.enabled === true
      ? {
          continuation: {
            enabled: true,
            conversationUrl: continuation.conversationUrl,
            settledMessageId: continuation.settledMessageId,
            draftState: draft.state,
          },
        }
      : {}),
  };
}

function compactDirectGoalClaimStep(
  step: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof step.id !== "string" || typeof step.state !== "string") return undefined;
  const reservation = objectValue(step.reservation);
  return {
    id: step.id,
    state: step.state,
    mode: step.mode,
    description: boundedInlineGoalText(step.description, 1_024),
    allowedToolNames: Array.isArray(step.allowedToolNames)
      ? step.allowedToolNames.slice(0, 64)
      : undefined,
    claimExpiresAtUnixMs: step.claimExpiresAtUnixMs,
    receiptCount: Array.isArray(step.receipts) ? step.receipts.length : 0,
    ...(typeof reservation.operationId === "string"
      ? {
          reservation: {
            operationId: reservation.operationId,
            state: reservation.state,
            toolName: reservation.toolName,
            stateEffect: reservation.stateEffect,
            modelEffect: reservation.modelEffect,
          },
        }
      : {}),
  };
}

function directGoalStateCounts(steps: readonly Record<string, unknown>[]): Record<string, number> {
  return Object.fromEntries(
    ["pending", "claimed", "awaiting_readback", "completed"].map((state) => [
      state,
      steps.filter((step) => step.state === state).length,
    ]),
  );
}

function compactDirectGoalResult(
  toolName: string,
  structuredContent: Record<string, unknown>,
  meta?: CallToolResult["_meta"],
): CallToolResult {
  const inline = {
    schemaVersion: 1,
    toolName,
    result: structuredContent,
  };
  return {
    content: [{ type: "text", text: `OMNICODEX_GOAL_STATE_V1:${JSON.stringify(inline)}` }],
    structuredContent,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function unresolvedGoalStepPriority(value: unknown): number {
  return value === "awaiting_readback" ? 0 : value === "claimed" ? 1 : value === "pending" ? 2 : 3;
}

function boundedInlineGoalText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function nativeOperationId(
  namespace: string,
  sessionId: string | undefined,
  requestId: string | number,
): string {
  const digest = createHash("sha256")
    .update(`${sessionId ?? namespace}\u0000${String(requestId)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(
    17,
    20,
  )}-${digest.slice(20)}`;
}

export function mutationIdentityInputPresence(
  args: Record<string, unknown>,
  requestMeta: unknown,
): MutationIdentityInputPresence {
  const meta = isObject(requestMeta) ? requestMeta : {};
  return {
    argument: Object.hasOwn(args, OMNICODEX_INVOCATION_ID),
    omnicodexMeta: Object.hasOwn(meta, "omnicodex/invocationId"),
    openAiMeta: Object.hasOwn(meta, "openai/toolInvocationId"),
  };
}

function mutationArguments(
  args: Record<string, unknown>,
  requestMeta: unknown,
):
  | {
      readonly ok: true;
      readonly invocationId?: string;
      readonly invocationIdSha256?: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly ok: false; readonly message: string } {
  const argumentPresent = Object.hasOwn(args, OMNICODEX_INVOCATION_ID);
  const argumentId = args[OMNICODEX_INVOCATION_ID];
  const meta = isObject(requestMeta) ? requestMeta : {};
  const omniMetaPresent = Object.hasOwn(meta, "omnicodex/invocationId");
  const omniMetaId = meta["omnicodex/invocationId"];
  const openAiMetaPresent = Object.hasOwn(meta, "openai/toolInvocationId");
  const openAiMetaId = meta["openai/toolInvocationId"];
  if (argumentPresent && !validInvocationId(argumentId)) {
    return {
      ok: false,
      message: `${OMNICODEX_INVOCATION_ID} must be a stable UUID-like identifier`,
    };
  }
  if (omniMetaPresent && !validInvocationId(omniMetaId)) {
    return { ok: false, message: "omnicodex/invocationId metadata is invalid" };
  }
  if (openAiMetaPresent && !validInvocationId(openAiMetaId)) {
    return { ok: false, message: "openai/toolInvocationId metadata is invalid" };
  }
  const suppliedIds = [
    ...(argumentPresent ? [argumentId as string] : []),
    ...(omniMetaPresent ? [omniMetaId as string] : []),
    ...(openAiMetaPresent ? [openAiMetaId as string] : []),
  ];
  const coherentIds = [...new Set(suppliedIds)];
  if (coherentIds.length > 1) {
    return { ok: false, message: "OmniCodex invocation identities disagree" };
  }
  const invocationId = coherentIds[0];
  const nativeArguments = { ...args };
  delete nativeArguments[OMNICODEX_INVOCATION_ID];
  return {
    ok: true,
    ...(invocationId === undefined
      ? {}
      : {
          invocationId,
          invocationIdSha256: createHash("sha256").update(invocationId, "utf8").digest("hex"),
        }),
    arguments: nativeArguments,
  };
}

function browserCallerAttributionContext(
  attribution: McpRequestAttribution | undefined,
): Pick<
  BrowserNativeCallContext,
  | "callerProvenance"
  | "chatGptConversationIdSha256"
  | "chatGptConversationId"
  | "callerActivityBinding"
  | "callerActivityBindingKind"
> {
  const chatGptConversationId =
    attribution?.chatGptConversationUrl === undefined
      ? undefined
      : exactChatGptConversationId(attribution.chatGptConversationUrl);
  const callerActivity = browserCallerActivity(attribution?.transportIdentityDigests);
  return {
    ...(attribution?.callerProvenance === undefined
      ? {}
      : { callerProvenance: attribution.callerProvenance }),
    ...(attribution?.chatGptConversationIdSha256 === undefined
      ? {}
      : { chatGptConversationIdSha256: attribution.chatGptConversationIdSha256 }),
    ...(chatGptConversationId === undefined ? {} : { chatGptConversationId }),
    ...(callerActivity === undefined ? {} : callerActivity),
  };
}

function browserCallerActivity(
  identities: readonly McpRequestIdentityDigest[] | undefined,
):
  | Pick<BrowserNativeCallContext, "callerActivityBinding" | "callerActivityBindingKind">
  | undefined {
  const relatedTask = identities?.find(
    (identity) =>
      identity.name === "meta:io.modelcontextprotocol/related-task" ||
      /^meta:\d+:io\.modelcontextprotocol\/related-task$/u.test(identity.name),
  );
  if (relatedTask !== undefined) {
    return {
      callerActivityBinding: `related-task:${relatedTask.valueHmac}`,
      callerActivityBindingKind: "related_task",
    };
  }
  const trace = identities?.find((identity) => identity.name === "header:traceparent-trace-id");
  return trace === undefined
    ? undefined
    : {
        callerActivityBinding: `transport-trace:${trace.valueHmac}`,
        callerActivityBindingKind: "transport_trace",
      };
}

async function withCoordinatedBrowserActivity<T>(
  options: OmniCodexMcpServerOptions,
  executor: BrowserNativeToolExecutor,
  context: BrowserNativeCallContext,
  operation: (context: BrowserNativeCallContext) => Promise<T>,
): Promise<T> {
  const attributedContext = await goalAttributedBrowserCallContext(options, context);
  if (
    options.browserActivityCoordinator === undefined ||
    executor.beginActivity === undefined ||
    executor.finishActivity === undefined
  ) {
    return operation(withoutExactBrowserConversationId(attributedContext));
  }
  if (options.browserActivityCoordinator.runWithActivity !== undefined) {
    return options.browserActivityCoordinator.runWithActivity(
      executor as BrowserActivityLifecycleExecutor,
      attributedContext,
      operation,
    );
  }
  return operation(
    await options.browserActivityCoordinator.coordinate(
      executor as BrowserActivityLifecycleExecutor,
      attributedContext,
    ),
  );
}

/**
 * Recover exact ChatGPT attribution from the server-owned Goal binding when
 * OpenAI's MCP transport supplies only its opaque session identity. The raw
 * conversation id exists only long enough for the activity coordinator to
 * adopt the durable work session; native execution receives its SHA-256.
 */
async function goalAttributedBrowserCallContext(
  options: OmniCodexMcpServerOptions,
  context: BrowserNativeCallContext,
): Promise<BrowserNativeCallContext> {
  if (
    context.callerProvenance !== "chatgpt_conversation" ||
    context.chatGptConversationId !== undefined ||
    context.ownerBinding === undefined ||
    context.workSessionBinding === undefined ||
    options.directGoalStore === undefined
  ) {
    return context;
  }
  try {
    const authorizationBinding = directGoalOwnerBinding(
      context.ownerBinding,
      context.workSessionBinding,
    );
    const goals = await options.directGoalStore.list([authorizationBinding], ["active"]);
    const conversationIds = new Set(
      goals.flatMap((goal) => {
        const normalizedUrl = normalizeChatGptConversationUrl(goal.continuation?.conversationUrl);
        const conversationId =
          normalizedUrl === undefined ? undefined : exactChatGptConversationId(normalizedUrl);
        return conversationId === undefined ? [] : [conversationId];
      }),
    );
    if (conversationIds.size !== 1) return context;
    const chatGptConversationId = [...conversationIds][0] as string;
    const chatGptConversationIdSha256 = createHash("sha256")
      .update(chatGptConversationId, "utf8")
      .digest("hex");
    if (
      context.chatGptConversationIdSha256 !== undefined &&
      context.chatGptConversationIdSha256 !== chatGptConversationIdSha256
    ) {
      return context;
    }
    return {
      ...context,
      chatGptConversationId,
      chatGptConversationIdSha256,
    };
  } catch {
    // Goal attribution augments an otherwise valid browser call. A transient
    // Goal-store read failure must not take Chrome access down with it.
    return context;
  }
}

function withoutExactBrowserConversationId(
  context: BrowserNativeCallContext,
): BrowserNativeCallContext {
  const { chatGptConversationId: _chatGptConversationId, ...safe } = context;
  return safe;
}

function exactChatGptConversationId(conversationUrl: string): string | undefined {
  try {
    const url = new URL(conversationUrl);
    const candidate = url.pathname.split("/").filter(Boolean).at(-1)?.toLocaleLowerCase("en-US");
    return candidate !== undefined &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(candidate)
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
}

function browserCallerAttributionObservation(
  context: BrowserNativeCallContext,
): Pick<McpRequestAttributionObservation, "callerProvenance" | "chatGptConversationIdSha256"> {
  return {
    ...(context.callerProvenance === undefined
      ? {}
      : { callerProvenance: context.callerProvenance }),
    ...(context.chatGptConversationIdSha256 === undefined
      ? {}
      : { chatGptConversationIdSha256: context.chatGptConversationIdSha256 }),
  };
}

/**
 * Preserve the authenticated request identity across execution, progress, and
 * result-delivery receipts. Raw conversation routes and bearer claims never
 * cross this boundary; only the gateway-issued privacy-safe commitments do.
 */
function requestAttributionObservation(
  attribution: McpRequestAttribution | McpRequestAttributionObservation | undefined,
): McpRequestAttributionObservation {
  return {
    ...(attribution?.principalBindingSha256 === undefined
      ? {}
      : { principalBindingSha256: attribution.principalBindingSha256 }),
    ...(attribution?.callerProvenance === undefined
      ? {}
      : { callerProvenance: attribution.callerProvenance }),
    ...(attribution?.invocationIdSha256 === undefined
      ? {}
      : { invocationIdSha256: attribution.invocationIdSha256 }),
    ...(attribution?.jsonRpcIdHmac === undefined
      ? {}
      : { jsonRpcIdHmac: attribution.jsonRpcIdHmac }),
    ...(attribution?.transportIdentityDigests === undefined
      ? {}
      : { transportIdentityDigests: attribution.transportIdentityDigests }),
    ...(attribution?.chatGptConversationIdSha256 === undefined
      ? {}
      : { chatGptConversationIdSha256: attribution.chatGptConversationIdSha256 }),
  };
}

interface ReadInvocationIdentity {
  readonly invocationId: string;
  readonly invocationIdSha256: string;
  readonly identityMode: "explicit" | "transport";
}

/**
 * ChatGPT can deliver one logical tool call through several simultaneously
 * initialized MCP transports. The JSON-RPC id and OpenTelemetry trace id can
 * remain stable across both retries and several distinct calls in one model
 * turn, while transport session ids and span ids change. Derive an opaque,
 * process-local turn identity from only those stable request fields. The read
 * coordinator adds the canonical target and arguments so exact retries fan in
 * without conflating distinct calls from that turn.
 */
function automaticTransportReadInvocation(
  attribution: McpRequestAttribution | undefined,
  workSessionBinding: string | undefined,
): ReadInvocationIdentity | undefined {
  if (attribution?.jsonRpcIdHmac === undefined) return undefined;
  const stableDigests = [
    ...new Map(
      (attribution.transportIdentityDigests ?? [])
        .filter((identity) =>
          [
            "header:traceparent-trace-id",
            "meta:openai/organization",
            "meta:openai/session",
            "meta:openai/subject",
          ].includes(identity.name),
        )
        .map((identity) => [`${identity.name}\0${identity.valueHmac}`, identity] as const),
    ).values(),
  ].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "en") ||
      left.valueHmac.localeCompare(right.valueHmac, "en"),
  );
  if (!stableDigests.some((identity) => identity.name === "header:traceparent-trace-id")) {
    return undefined;
  }
  const invocationId = `transport:${semanticDigest({
    contract: "omnicodex-transport-read-invocation-v1",
    principalBindingSha256: attribution.principalBindingSha256,
    jsonRpcIdHmac: attribution.jsonRpcIdHmac,
    stableDigests,
    ...(workSessionBinding === undefined
      ? {}
      : { workSessionBindingSha256: semanticDigest(workSessionBinding) }),
  })}`;
  return {
    invocationId,
    invocationIdSha256: createHash("sha256").update(invocationId, "utf8").digest("hex"),
    identityMode: "transport",
  };
}

function validInvocationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 16 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  );
}

function errorCode(error: unknown): string | undefined {
  if (!isObject(error) || typeof error.code !== "string") return undefined;
  return /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code) ? error.code : undefined;
}

function jsonReplayValue(value: CallToolResult): MutationReplayJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Mutation result is not JSON serializable");
  return JSON.parse(serialized) as MutationReplayJsonValue;
}

function jsonReadInvocationValue(value: CallToolResult): ReadInvocationJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Read result is not JSON serializable");
  return JSON.parse(serialized) as ReadInvocationJsonValue;
}

function replayedReadCallToolResult(value: ReadInvocationJsonValue): CallToolResult {
  if (!isObject(value) || !Array.isArray(value.content)) {
    return errorResult("READ_INVOCATION_RESULT_INVALID");
  }
  return value as unknown as CallToolResult;
}

function replayedCallToolResult(value: MutationReplayJsonValue): CallToolResult {
  if (!isObject(value) || !Array.isArray(value.content)) {
    return errorResult("MUTATION_REPLAY_RESULT_INVALID");
  }
  return value as unknown as CallToolResult;
}

function mutationTerminalResult(
  terminal:
    | MutationReplayTerminal<MutationReplayJsonValue>
    | LegacyMutationTerminal<MutationReplayJsonValue>,
): CallToolResult {
  if (terminal.kind === "completed") return replayedCallToolResult(terminal.value);
  if (terminal.kind === "outcome_unknown") {
    return errorResult(`MUTATION_OUTCOME_UNKNOWN: ${terminal.code}`);
  }
  return errorResult(`MUTATION_NOT_DISPATCHED: ${terminal.code}`);
}

function directJobDispatchOutcome(
  result: CallToolResult,
  signal: AbortSignal,
): DirectJobDispatchOutcome {
  if (resultOutcome(result) === "succeeded") return { status: "succeeded", result };
  const message = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  if (signal.aborted) {
    return {
      status: "cancelled",
      code: "DIRECT_JOB_CANCELLED",
      message: message || "Native direct tool acknowledged cancellation",
    };
  }
  if (
    message.startsWith("MUTATION_OUTCOME_UNKNOWN:") ||
    message.startsWith("DIRECT_GOAL_OUTCOME_UNKNOWN:")
  ) {
    return {
      status: "outcome_unknown",
      code: "DIRECT_JOB_NATIVE_OUTCOME_UNKNOWN",
      message: message || "Native direct tool outcome is unknown",
    };
  }
  if (message.includes("DIRECT_JOB_CATALOG_CHANGED")) {
    return { status: "failed", code: "DIRECT_JOB_CATALOG_CHANGED", result };
  }
  return { status: "failed", result };
}

/**
 * Every first-class tool advertised beside the discovered registry participates
 * in the same revision. Otherwise a Codex app or browser-surface update can
 * change a public schema without invalidating cursors or notifying existing MCP
 * sessions.
 */
async function refreshNativeToolRegistry(options: {
  readonly catalog: NativeToolCatalog;
  readonly appServerMethodCatalog?: AppServerMethodCatalog;
  readonly responsesToolCatalog?: ResponsesNativeToolCatalog;
  readonly codexAppHostToolExecutor: CodexAppHostToolExecutor;
  readonly includeBrowserNative: boolean;
  readonly includeDirectGoals: boolean;
  readonly includeDirectJobs: boolean;
  readonly includeDirectSchedules: boolean;
  readonly protectMutations: boolean;
  readonly serverIdentity?: string;
}): Promise<{
  readonly registry: NativeToolRegistrySnapshot;
  readonly hostSnapshot: CodexAppHostToolCatalogSnapshot;
  readonly serverErrors: readonly { readonly server: string; readonly toolsError: string }[];
}> {
  const [hostSnapshot, snapshot, methodSnapshot, responsesSnapshot] = await Promise.all([
    options.codexAppHostToolExecutor.prepareToolsRefresh(),
    options.catalog.prepareRefresh(),
    options.appServerMethodCatalog?.prepareRefresh(),
    options.responsesToolCatalog?.prepareRefresh(),
  ]);
  const registry = withFirstClassCatalogRevision(
    buildNativeToolRegistry({
      reservedNames: reservedToolNames,
      appServerMethods: methodSnapshot?.methods ?? [],
      responsesTools: responsesSnapshot?.tools ?? [],
      downstreamTools: snapshot.tools,
    }),
    hostSnapshot,
    options.includeBrowserNative,
    options.protectMutations,
    options.includeDirectGoals,
    options.includeDirectJobs,
    options.includeDirectSchedules,
    options.serverIdentity,
  );
  // All discovery and public-revision construction completed successfully.
  // These synchronous commits therefore publish one complete generation in a
  // single event-loop turn; no request can observe a mixed old/new catalog.
  options.codexAppHostToolExecutor.commitToolsRefresh(hostSnapshot);
  options.catalog.commitRefresh(snapshot);
  if (methodSnapshot !== undefined) options.appServerMethodCatalog?.commitRefresh(methodSnapshot);
  if (responsesSnapshot !== undefined)
    options.responsesToolCatalog?.commitRefresh(responsesSnapshot);
  return { registry, hostSnapshot, serverErrors: snapshot.serverErrors ?? [] };
}

function withFirstClassCatalogRevision(
  registry: NativeToolRegistrySnapshot,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative: boolean,
  protectMutations: boolean,
  includeDirectGoals: boolean,
  includeDirectJobs: boolean,
  includeDirectSchedules: boolean,
  serverIdentity?: string,
): NativeToolRegistrySnapshot {
  const publicCatalog = fullCatalogEntries(
    registry,
    codexAppHostToolCatalog,
    includeBrowserNative,
    protectMutations,
    includeDirectGoals,
    includeDirectJobs,
    includeDirectSchedules,
  ).map((entry) => {
    const advertisedTool =
      serverIdentity === undefined
        ? entry.tool
        : withOmniCodexServerIdentity(entry.tool, serverIdentity);
    return {
      name: entry.name,
      toolId: entry.toolId,
      revisionIdentity: entry.revisionIdentity,
      tool: withoutCatalogRevision(advertisedTool),
    };
  });
  const revision = createHash("sha256").update(canonicalJson(publicCatalog), "utf8").digest("hex");
  const entries = registry.entries.map(
    (entry) =>
      ({
        ...entry,
        tool: withCatalogRevision(entry.tool, revision),
      }) as NativeToolRegistryEntry,
  );
  return {
    revision,
    entries,
    tools: entries.map((entry) => entry.tool),
  };
}

function withoutCatalogRevision(tool: Tool): Tool {
  if (!isObject(tool._meta) || !isObject(tool._meta.omnicodex)) return tool;
  const { catalogRevision: _revision, ...omniCodex } = tool._meta.omnicodex;
  return {
    ...tool,
    _meta: {
      ...tool._meta,
      omnicodex: omniCodex,
    },
  } as Tool;
}

function withCatalogRevision(tool: Tool, revision: string): Tool {
  const metadata = isObject(tool._meta) ? tool._meta : {};
  const omniCodex = isObject(metadata.omnicodex) ? metadata.omnicodex : {};
  return {
    ...tool,
    _meta: {
      ...metadata,
      omnicodex: { ...omniCodex, catalogRevision: revision },
    },
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function semanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function mutationSemanticFingerprint(
  context: { readonly targetIdentity: string; readonly targetContractDigest: string },
  args: Record<string, unknown>,
): string {
  return semanticDigest({
    contract: "omnicodex-mutation-v1",
    targetIdentity: context.targetIdentity,
    targetContractDigest: context.targetContractDigest,
    arguments: args,
  });
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

/** Adapt one native descriptor to the MCP wire shape. */
function publicActionTool(tool: Tool): Tool {
  // `namespace` is a renderer-side catalog coordinate rather than an MCP Tool
  // field. Its value is preserved as nativeNamespace in the registry/search
  // envelope; omitting it here keeps direct listTools and search descriptors
  // byte-for-byte equivalent after MCP wire validation.
  const { namespace: _rendererNamespace, ...wireTool } = tool as Tool & {
    readonly namespace?: unknown;
  };
  const input = mcpWireObjectSchema(presentedNativeToolInputSchema(tool.inputSchema), true);
  const output =
    tool.outputSchema === undefined ? undefined : mcpWireOutputSchema(tool.outputSchema);
  const metadata =
    presentedNativeToolMetadata(isObject(wireTool._meta) ? wireTool._meta : {}) ?? {};
  const { omnicodex: _omnicodexMetadata, ...publicMetadata } = metadata;
  const { toolId, catalogRevision } = objectValue(metadata.omnicodex);
  const publicOmniCodexMetadata = {
    ...(typeof toolId === "string" ? { toolId } : {}),
    ...(typeof catalogRevision === "string" ? { catalogRevision } : {}),
  };
  const base = {
    ...wireTool,
    annotations: allFalseCatalogAnnotations(),
    ...(typeof tool.description === "string"
      ? { description: publicToolDescription(tool.description) }
      : {}),
    inputSchema: input.schema as Tool["inputSchema"],
    ...(output === undefined
      ? {}
      : { outputSchema: output.schema as NonNullable<Tool["outputSchema"]> }),
    _meta: {
      ...publicMetadata,
      ...(Object.keys(publicOmniCodexMetadata).length === 0
        ? {}
        : { omnicodex: publicOmniCodexMetadata }),
    },
  } as Tool;
  return base;
}

/**
 * Renderer descriptors may append a shared TypeScript declaration bundle to
 * each tool description. The schema has already been captured before this
 * boundary, so remove only that exact transport suffix and never impose a
 * length ceiling on the actual public description.
 */
function publicToolDescription(description: string): string {
  return presentedNativeToolDescription({ description }) ?? "";
}

/**
 * MCP tool results require an object-shaped `structuredContent`. Native Codex
 * tools are not limited to object outputs, so represent every non-object root
 * schema as one lossless value envelope. The result mapper below uses this
 * exact same rule; the advertised schema and returned value cannot drift.
 */
function mcpWireOutputSchema(value: unknown): {
  readonly schema: Record<string, unknown>;
  readonly enveloped: boolean;
} {
  const compatible = mcpWireSchemaNode(value);
  if (isObject(compatible.schema) && compatible.schema.type === "object") {
    return { schema: compatible.schema, enveloped: false };
  }
  return {
    schema: {
      type: "object",
      properties: { value: compatible.schema },
      required: ["value"],
      additionalProperties: false,
    },
    enveloped: true,
  };
}

function mcpWireObjectSchema(
  value: unknown,
  envelopeExplicitNonObject = false,
): {
  readonly schema: Record<string, unknown>;
  readonly adapted: boolean;
} {
  const compatible = mcpWireSchemaNode(value);
  const resolved = inlineRootLocalReference(compatible.schema);
  if (!isObject(resolved.schema)) {
    return { schema: { type: "object", additionalProperties: true }, adapted: true };
  }
  if (
    envelopeExplicitNonObject &&
    typeof resolved.schema.type === "string" &&
    resolved.schema.type !== "object"
  ) {
    return {
      schema: {
        type: "object",
        properties: { arguments: resolved.schema },
        required: ["arguments"],
        additionalProperties: false,
      },
      adapted: true,
    };
  }
  if (resolved.schema.type === "object") {
    return {
      schema: resolved.schema,
      adapted: compatible.adapted || resolved.adapted,
    };
  }
  if (resolved.schema.type === undefined) {
    return { schema: { ...resolved.schema, type: "object" }, adapted: true };
  }
  return {
    schema: { type: "object", allOf: [resolved.schema] },
    adapted: true,
  };
}

/**
 * ChatGPT Apps requires a concrete object at the tool-input root. Codex's
 * generated protocol schema commonly places a local reference there. Inline
 * only that root reference; nested references and their bundled definitions
 * remain untouched, so recursive schemas retain their exact meaning.
 */
function inlineRootLocalReference(value: unknown): {
  readonly schema: unknown;
  readonly adapted: boolean;
} {
  if (!isObject(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/")) {
    return { schema: value, adapted: false };
  }
  const target = resolveLocalJsonPointer(value, value.$ref);
  if (!isObject(target)) return { schema: value, adapted: false };
  const { $ref: _rootReference, ...siblings } = value;
  // A $ref and its siblings are simultaneous constraints. Object spreading
  // must not replace the referenced required/properties/allOf with a sibling.
  // Keep the original document definitions at the root so nested refs retain
  // their original resolution base, and compose the target when keys overlap.
  if (Object.keys(siblings).some((key) => Object.hasOwn(target, key))) {
    const { allOf, ...rootSiblings } = siblings;
    return {
      schema: {
        ...rootSiblings,
        ...(rootSiblings.type === undefined && target.type !== undefined
          ? { type: target.type }
          : {}),
        allOf: [target, ...(Array.isArray(allOf) ? allOf : [])],
      },
      adapted: true,
    };
  }
  return { schema: { ...target, ...siblings }, adapted: true };
}

function resolveLocalJsonPointer(root: Record<string, unknown>, reference: string): unknown {
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(2));
  } catch {
    return undefined;
  }
  let current: unknown = root;
  for (const rawSegment of pointer.split("/")) {
    if (!isObject(current)) return undefined;
    const segment = rawSegment.replace(/~1/gu, "/").replace(/~0/gu, "~");
    current = current[segment];
  }
  return current;
}

function mcpWireSchemaNode(value: unknown): {
  readonly schema: unknown;
  readonly adapted: boolean;
} {
  if (value === true) return { schema: {}, adapted: true };
  if (value === false) return { schema: { not: {} }, adapted: true };
  if (!isObject(value)) return { schema: value, adapted: false };

  let adapted = false;
  const schema: Record<string, unknown> = { ...value };
  for (const key of [
    "properties",
    "patternProperties",
    "$defs",
    "definitions",
    "dependentSchemas",
  ] as const) {
    const map = value[key];
    if (!isObject(map)) continue;
    const entries = Object.entries(map).map(([name, child]) => {
      const compatible = mcpWireSchemaNode(child);
      adapted ||= compatible.adapted;
      return [name, compatible.schema];
    });
    schema[key] = Object.fromEntries(entries);
  }
  for (const key of ["prefixItems", "allOf", "anyOf", "oneOf"] as const) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    schema[key] = list.map((child) => {
      const compatible = mcpWireSchemaNode(child);
      adapted ||= compatible.adapted;
      return compatible.schema;
    });
  }
  for (const key of [
    "additionalProperties",
    "propertyNames",
    "contains",
    "items",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ] as const) {
    const child = value[key];
    if (child === undefined || (key === "additionalProperties" && typeof child === "boolean")) {
      continue;
    }
    const compatible = mcpWireSchemaNode(child);
    adapted ||= compatible.adapted;
    schema[key] = compatible.schema;
  }
  if (isObject(value.dependencies)) {
    schema.dependencies = Object.fromEntries(
      Object.entries(value.dependencies).map(([name, dependency]) => {
        if (Array.isArray(dependency)) return [name, dependency];
        const compatible = mcpWireSchemaNode(dependency);
        adapted ||= compatible.adapted;
        return [name, compatible.schema];
      }),
    );
  }
  return { schema, adapted };
}

function nativeRouterTools(): Tool[] {
  const targetProperties = {
    name: {
      type: "string",
      description: "Exact exposed or native tool name. No prior search call is required.",
    },
    toolId: { type: "string", description: "Exact tool id returned by search_native_tools." },
    query: {
      type: "string",
      minLength: 1,
      description:
        "Capability description for native-tool lookup. A unique match executes atomically; an ambiguous match returns candidate names without side effects.",
    },
    arguments: { description: "Exact JSON value matching the target tool's inputSchema." },
    input: {
      type: "string",
      description: "Exact freeform input for custom or freeform targets only.",
    },
    payload: {
      description: "Exact JSON payload for unknown-kind targets only.",
    },
    expectedCatalogRevision: { type: "string" },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      description: "Optional caller-selected execution deadline in milliseconds.",
    },
  };
  return [
    {
      name: "search_native_tools",
      title: "Find native OmniCodex tools directly",
      description:
        "Search live Codex tools by name or terms; use * and nextCursor for the full catalog. Each match includes the native descriptor, input schema, and exact executeWith/executeArguments. Set includeSkills to find installed Codex skills by name; skill results are non-callable metadata, not browser surfaces.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            description:
              "Exact exposed/native action name or search terms. Use * to browse the complete catalog.",
          },
          includeSkills: { type: "boolean", description: "Also search installed Codex skills." },
          namespace: { type: "string" },
          kind: { type: "string" },
          modelEffect: { enum: ["none", "model", "unknown"] },
          limit: {
            type: "integer",
            minimum: 1,
            description:
              "Optional caller-selected page size. When omitted, every remaining match is returned.",
          },
          cursor: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: {
          count: { type: "integer", minimum: 0 },
          query: {
            type: "string",
            description: "Normalized query actually executed by the server.",
          },
          totalCount: {
            type: "integer",
            minimum: 0,
            description:
              "Total matches across all lossless pages for the current query and filters.",
          },
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                toolId: { type: "string" },
                source: { type: "string" },
                name: { type: "string" },
                nativeName: { type: "string" },
                nativeNamespace: { type: "string" },
                kind: { type: "string" },
                modelEffect: { enum: ["none", "model", "unknown"] },
                invokesModel: { enum: [true, false, null] },
                route: { type: "string" },
                catalogRevision: { type: "string" },
                nativeTool: {
                  type: "object",
                  description:
                    "The one exact source-native tool descriptor. Web routing is supplied separately by executeWith and executeArguments so the native metadata is never rewritten or duplicated.",
                  additionalProperties: true,
                },
                executionAnnotations: {
                  type: "object",
                  description:
                    "Annotations of the callable MCP action when different from the preserved nativeTool annotations. These match the direct tools/list entry.",
                  additionalProperties: true,
                },
                executionInputSchema: {
                  type: "object",
                  description:
                    "Actual invocation argument schema when it differs from nativeTool.inputSchema. Use it directly for a native executeWith action, or for the target arguments inside call_native_tool arguments. The preserved nativeTool remains the source contract.",
                  additionalProperties: true,
                },
                executeWith: {
                  type: "string",
                  description:
                    "Exact callable action name. This is the advertised native action when present and call_native_tool otherwise.",
                },
                executeArguments: {
                  type: "object",
                  description:
                    "Arguments for executeWith. Replace descriptive placeholder strings with the requested values before invoking it.",
                  additionalProperties: true,
                },
                server: { type: "string" },
              },
              required: [
                "toolId",
                "source",
                "name",
                "nativeName",
                "kind",
                "modelEffect",
                "invokesModel",
                "nativeTool",
                "executeWith",
                "executeArguments",
              ],
              additionalProperties: false,
            },
          },
          skillsTotalCount: { type: "integer", minimum: 0 },
          skills: { type: "array", items: { type: "object", additionalProperties: true } },
          catalogRevision: { type: "string" },
          nextCursor: { type: "string" },
        },
        required: ["count", "totalCount", "query", "tools", "catalogRevision"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    } as Tool,
    {
      name: "call_native_tool",
      title: "Use an installed Codex tool",
      description:
        "Calls the selected installed Codex tool with its original arguments and returns its complete native result. Select it by exact name or toolId, or use a capability query when the exact name is unknown. A unique query match runs immediately; multiple matches return the candidate names.",
      inputSchema: {
        type: "object",
        properties: {
          ...targetProperties,
          ordering: {
            type: "object",
            properties: {
              threadId: { type: "string" },
              processId: { type: "string" },
              filePaths: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    } as Tool,
    {
      name: "app_server_rpc",
      title: "Call a Codex App Server method",
      description:
        "Calls one exact method from the current installed Codex App Server catalog and returns its complete result. Arguments and an optional caller-selected completion deadline are passed through unchanged.",
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", minLength: 1 },
          params: { type: "object", additionalProperties: true },
          expectedCatalogRevision: { type: "string" },
          timeoutMs: { type: "integer", minimum: 1 },
        },
        required: ["method"],
        additionalProperties: false,
      },
    } as Tool,
  ];
}

const browserNativeToolNames = [
  "browser__list_surfaces",
  "chrome__list_user_tabs",
  "chrome__control_chrome",
  "browser__control_in_app_browser",
] as const;

type BrowserNativeToolName = (typeof browserNativeToolNames)[number];

function browserExecutionTool(
  registry: NativeToolRegistrySnapshot,
  hostCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
): Tool | undefined {
  return (
    hostCatalog.tools.find((entry) => entry.nativeName === "node_repl/js")?.tool ??
    registry.entries.find(
      (entry) =>
        entry.route === "downstream" &&
        entry.descriptor.server === "node_repl" &&
        entry.descriptor.originalName === "js",
    )?.tool
  );
}

function browserNativeTools(nativeExecutionTool?: Tool): Tool[] {
  return codeModeBrowserNativeTools(nativeExecutionTool).map((tool) => {
    const remoteInputSchema =
      tool.name !== "browser__control_in_app_browser"
        ? tool.name === "chrome__control_chrome"
          ? {
              ...tool.inputSchema,
              properties: {
                ...objectValue(tool.inputSchema.properties),
                omnicodexInvocationId: {
                  type: "string",
                  minLength: 16,
                  maxLength: 128,
                  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
                  description:
                    "Client-owned stable identity for one new logical mutation. Reuse the same ID and arguments for retransmission; use a different ID only for an independently established new intent. Never mint an ID to retry or reclassify an unresolved legacy mutation. Omit for legacy clients. Removed before native dispatch.",
                },
              },
            }
          : tool.inputSchema
        : {
            ...tool.inputSchema,
            properties: {
              ...objectValue(tool.inputSchema.properties),
              contextThreadId: {
                type: "string",
                minLength: 1,
                description:
                  "Exact live Codex Desktop task id used to resolve the task's in-app browser runtime.",
              },
            },
            required: [...schemaRequiredProperties(tool.inputSchema), "contextThreadId"],
          };
    const adapterMetadata =
      tool.name === "browser__list_surfaces"
        ? browserNativeMetadata("browser/list_surfaces")
        : tool.name === "chrome__list_user_tabs"
          ? browserNativeMetadata("chrome/list_user_tabs")
          : tool.name === "chrome__control_chrome"
            ? browserNativeMetadata("chrome/control", "mutate")
            : browserNativeMetadata("in_app_browser/control", "mutate");
    const nativeMetadata = objectValue(tool._meta);
    return {
      ...tool,
      inputSchema: remoteInputSchema,
      _meta: {
        ...nativeMetadata,
        ...adapterMetadata,
        omnicodex: {
          ...objectValue(nativeMetadata.omnicodex),
          ...objectValue(adapterMetadata.omnicodex),
        },
      },
    } as Tool;
  });
}

function schemaRequiredProperties(schema: Tool["inputSchema"]): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
}

function browserNativeMetadata(nativeName: string, _stateEffect: "read" | "mutate" = "read") {
  return {
    omnicodex: {
      nativeName,
      nativeNamespace: "codex_browser_client",
      modelEffect: "none",
      invokesModel: false,
      route: "browser_native",
      stable: true,
    },
  };
}

interface DirectSearchTool {
  readonly direct: true;
  readonly exposedName: string;
  readonly catalogExposedName: string;
  readonly originalName: string;
  readonly kind: "function";
  readonly tool: Tool;
  /** Exact renderer/browser adapter descriptor before public catalog decoration. */
  readonly nativeTool: Tool;
  readonly toolId: string;
  readonly source: string;
  readonly nativeNamespace: string;
  readonly modelEffect: "none" | "model";
  readonly invokesModel: boolean;
  readonly stateEffect: "read" | "mutate";
  readonly route:
    | "browser_native"
    | "codex_app_native"
    | "computer_use_native"
    | "omnicodex_job"
    | "omnicodex_result"
    | "omnicodex_legacy_status"
    | "omnicodex_resource"
    | "omnicodex_goal"
    | "omnicodex_router"
    | "omnicodex_schedule"
    | "omnicodex_browser_activity"
    | "omnicodex_session";
  readonly catalogRevision: string;
}

function hostToolIdentity(entry: CodexAppHostToolDescriptor): {
  readonly nativeNamespace: string;
  readonly route: "codex_app_native" | "computer_use_native";
  readonly source: "codex_app_host" | "codex_computer_use_host";
} {
  const metadata = isObject(entry.tool._meta) ? entry.tool._meta.omnicodex : undefined;
  const parsedNativeName = splitNativeIdentity(entry.nativeName);
  const nativeNamespace =
    isObject(metadata) && typeof metadata.nativeNamespace === "string"
      ? metadata.nativeNamespace
      : (parsedNativeName.namespace ?? "codex_app");
  const route =
    isObject(metadata) && metadata.route === "computer_use_native"
      ? "computer_use_native"
      : "codex_app_native";
  return {
    nativeNamespace,
    route,
    source: route === "computer_use_native" ? "codex_computer_use_host" : "codex_app_host",
  };
}

function isIdempotentMcpServerReload(nativeNamespace: string, nativeName: string): boolean {
  return nativeNamespace === "app_server" && nativeName === "config/mcpServer/reload";
}

type NativeSearchEntry = NativeToolRegistryEntry | DirectSearchTool;

function isDirectSearchTool(entry: NativeSearchEntry): entry is DirectSearchTool {
  return "direct" in entry && entry.direct === true;
}

/** Build the directly callable host/browser candidates once per search. */
function directSearchTools(
  catalogRevision: string,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative: boolean,
  _protectMutations: boolean,
  nativeExecutionTool?: Tool,
): readonly DirectSearchTool[] {
  const hostTools: DirectSearchTool[] = codexAppHostToolCatalog.tools.map((entry) => {
    const identity = hostToolIdentity(entry);
    // The renderer descriptor carries an unqualified local `name`, while the
    // Codex model-facing tool surface qualifies it with its namespace. Keep
    // every native field and schema intact, but advertise the exact callable
    // model-facing identity so tools from different namespaces cannot collide.
    const nativeTool = structuredClone(entry.tool) as Tool;
    const versioned = withCatalogRevision({ ...entry.tool, name: entry.name }, catalogRevision);
    const tool = versioned;
    return {
      direct: true,
      exposedName: tool.name,
      catalogExposedName: tool.name,
      originalName: entry.nativeName,
      kind: "function",
      tool,
      nativeTool,
      toolId: firstClassToolId(
        "function",
        identity.source,
        identity.nativeNamespace,
        entry.nativeName,
      ),
      source: identity.source,
      nativeNamespace: identity.nativeNamespace,
      modelEffect: entry.modelEffect,
      invokesModel: entry.modelEffect === "model",
      stateEffect: entry.stateEffect,
      route: identity.route,
      catalogRevision,
    };
  });
  const browserTools: DirectSearchTool[] = includeBrowserNative
    ? browserNativeTools(nativeExecutionTool).map((tool) => {
        const originalName =
          tool.name === "browser__list_surfaces"
            ? "browser/list_surfaces"
            : tool.name === "chrome__list_user_tabs"
              ? "chrome/list_user_tabs"
              : tool.name === "chrome__control_chrome"
                ? "chrome/control"
                : "in_app_browser/control";
        const stateEffect =
          tool.name === "browser__list_surfaces" || tool.name === "chrome__list_user_tabs"
            ? "read"
            : "mutate";
        const nativeTool = structuredClone(tool) as Tool;
        if (
          tool.name === "chrome__control_chrome" &&
          nativeTool.inputSchema.properties !== undefined
        ) {
          delete nativeTool.inputSchema.properties.omnicodexInvocationId;
        }
        const callableTool = tool;
        return {
          direct: true,
          exposedName: callableTool.name,
          catalogExposedName: callableTool.name,
          originalName,
          kind: "function",
          tool: callableTool,
          nativeTool,
          toolId: firstClassToolId(
            "function",
            "codex_browser_client",
            "codex_browser_client",
            originalName,
          ),
          source: "codex_browser_client",
          nativeNamespace: "codex_browser_client",
          modelEffect: "none",
          invokesModel: false,
          stateEffect,
          route: "browser_native",
          catalogRevision,
        };
      })
    : [];
  return [...hostTools, ...browserTools].sort(
    (left, right) =>
      left.exposedName.localeCompare(right.exposedName, "en") ||
      left.toolId.localeCompare(right.toolId, "en"),
  );
}

/**
 * Merge the directly callable surface into the registry search space. A
 * direct public tool replaces a generated alias for the same public name, so
 * discovery never returns both a host/browser action and a router-backed
 * duplicate. Non-overlapping registry entries retain their original order,
 * which keeps broad-search cursors deterministic.
 */
function nativeSearchEntries(
  registry: NativeToolRegistrySnapshot,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative: boolean,
  protectMutations: boolean,
): readonly NativeSearchEntry[] {
  const direct = directSearchTools(
    registry.revision,
    codexAppHostToolCatalog,
    includeBrowserNative,
    protectMutations,
    browserExecutionTool(registry, codexAppHostToolCatalog),
  );
  const directByPublicName = new Map(direct.map((entry) => [entry.exposedName, entry]));
  const includedDirectNames = new Set<string>();
  const merged: NativeSearchEntry[] = [];
  for (const entry of registry.entries) {
    const replacement = [entry.exposedName, entry.catalogExposedName, entry.originalName]
      .map((name) => directByPublicName.get(name))
      .find((candidate) => candidate !== undefined);
    if (replacement === undefined) {
      merged.push(entry);
      continue;
    }
    if (!includedDirectNames.has(replacement.exposedName)) {
      merged.push(replacement);
      includedDirectNames.add(replacement.exposedName);
    }
  }
  for (const entry of direct) {
    if (includedDirectNames.has(entry.exposedName)) continue;
    merged.push(entry);
    includedDirectNames.add(entry.exposedName);
  }
  return merged;
}

/**
 * Build the lossless `/mcp/full` source set. Search may prefer one convenient
 * route for a human-facing hit, but the first-class catalog must preserve every
 * distinct native identity even when routes reuse the same public or native
 * name. Only an exact stable tool identity is de-duplicated, with the directly
 * callable descriptor taking precedence for that identical identity.
 */
function fullNativeCatalogEntries(
  registry: NativeToolRegistrySnapshot,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative: boolean,
  protectMutations: boolean,
): readonly NativeSearchEntry[] {
  const byToolId = new Map<string, NativeSearchEntry>();
  for (const entry of registry.entries) byToolId.set(entry.toolId, entry);
  for (const entry of directSearchTools(
    registry.revision,
    codexAppHostToolCatalog,
    includeBrowserNative,
    protectMutations,
    browserExecutionTool(registry, codexAppHostToolCatalog),
  )) {
    byToolId.set(entry.toolId, entry);
  }
  return [...byToolId.values()];
}

function isBrowserNativeTool(name: string): name is BrowserNativeToolName {
  return (browserNativeToolNames as readonly string[]).includes(name);
}

function browserToolIdentity(
  name: BrowserNativeToolName,
  args: Readonly<Record<string, unknown>> = {},
): {
  readonly nativeNamespace: "codex_browser_client";
  readonly originalName:
    | "browser/list_surfaces"
    | "chrome/list_user_tabs"
    | "chrome/control"
    | "in_app_browser/control";
  readonly source: "codex_browser_client";
  readonly stateEffect: "read" | "mutate";
} {
  return {
    nativeNamespace: "codex_browser_client",
    originalName:
      name === "browser__list_surfaces"
        ? "browser/list_surfaces"
        : name === "chrome__list_user_tabs"
          ? "chrome/list_user_tabs"
          : name === "chrome__control_chrome"
            ? "chrome/control"
            : "in_app_browser/control",
    source: "codex_browser_client",
    stateEffect: browserNativeStateEffect(name, args),
  };
}

function browserNativeStateEffect(
  name: BrowserNativeToolName,
  args: Readonly<Record<string, unknown>>,
): "read" | "mutate" {
  return name === "browser__list_surfaces" ||
    name === "chrome__list_user_tabs" ||
    classifyBrowserNativeOperation(args.operation, args.code) !== "exec"
    ? "read"
    : "mutate";
}

function isAuthoritativeBrowserInspection(
  name: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return (
    name === "chrome__control_chrome" &&
    classifyBrowserNativeOperation(args.operation, args.code) === "inspect"
  );
}

function isAuthoritativeBrowserResourceReadback(
  name: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  return name === "chrome__list_user_tabs" || isAuthoritativeBrowserInspection(name, args);
}

function successfulBrowserResourceReadback(value: unknown): boolean {
  return isObject(value) && resultOutcome(value as CallToolResult) === "succeeded";
}

function browserContextThreadId(
  name: BrowserNativeToolName,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  if (name !== "browser__control_in_app_browser") return undefined;
  const contextThreadId =
    typeof args.contextThreadId === "string" && args.contextThreadId.trim().length > 0
      ? args.contextThreadId.trim()
      : undefined;
  if (contextThreadId === undefined) {
    throw new Error(
      "IAB_CONTEXT_THREAD_ID_REQUIRED: remote in-app browser control requires an exact live Codex Desktop task id",
    );
  }
  return contextThreadId;
}

async function callBrowserNativeTool(
  executor: BrowserNativeToolExecutor,
  name: BrowserNativeToolName,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  browserCallContext: BrowserNativeCallContext = {},
): Promise<CallToolResult> {
  const identity = browserToolIdentity(name, args);
  const contextThreadId = browserContextThreadId(name, args);
  const nativeArgs = { ...args };
  delete nativeArgs.contextThreadId;
  delete nativeArgs.ownerBinding;
  delete nativeArgs.workSessionBinding;
  delete nativeArgs.callerSessionId;
  delete nativeArgs.contextTurnId;
  delete nativeArgs.operationId;
  const argumentsValue =
    name === "browser__list_surfaces"
      ? { operation: "list_surfaces" }
      : name === "chrome__list_user_tabs"
        ? { operation: "list_user_tabs", surface: "chrome", ...nativeArgs }
        : {
            ...nativeArgs,
            operation: classifyBrowserNativeOperation(nativeArgs.operation, nativeArgs.code),
            surface: name === "chrome__control_chrome" ? "chrome" : "iab",
          };
  const result = await executor.call(argumentsValue, {
    ...browserCallContext,
    ...(contextThreadId === undefined ? {} : { contextThreadId }),
    ...(signal === undefined ? {} : { signal }),
  });
  return toCallToolResult(
    result,
    {
      tool: name,
      source: identity.source,
      originalName: identity.originalName,
      route: "browser_native",
      stateEffect: identity.stateEffect,
      ...browserCallerAttributionObservation(browserCallContext),
    },
    browserNativeTools().find((tool) => tool.name === name)?.outputSchema,
  );
}

/**
 * Per-frame transport budget for `/mcp/full` tools/list. This is deliberately
 * not a catalog limit: a signed nextCursor is emitted until every entry has
 * been delivered, and an individually oversized tool is still returned alone.
 */
export const OMNICODEX_FULL_CATALOG_PAGE_BYTE_BUDGET = 512 * 1024;

/**
 * Per-page budget for `search_native_tools` structured content. Exact native
 * descriptors are carried once in structuredContent while content contains
 * only a compact routing manifest. This is a transport page size, not a result
 * cap: `nextCursor` continues until every match has been delivered, and one
 * individually oversized descriptor is still returned alone.
 */
export const OMNICODEX_NATIVE_SEARCH_PAGE_BYTE_BUDGET = 192 * 1024;

/**
 * ChatGPT currently rejects a developer-app action catalog when the combined
 * tool names, descriptions, and input schemas exceed 100,000 tokens. UTF-8
 * bytes are a conservative tokenizer-independent upper bound, with room left
 * for the platform's own envelope. This limits only eagerly registered direct
 * descriptors; the native catalog and executable search/router surface remain
 * complete.
 */
export const OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET = 88 * 1024;

function fullToolPage(
  registry: NativeToolRegistrySnapshot,
  cursor: string | undefined,
  includeBrowserNative: boolean,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  protectMutations: boolean,
  includeDirectGoals: boolean,
  includeDirectJobs: boolean,
  includeDirectSchedules: boolean,
  cursorScope: string,
  serverIdentity?: string,
): ListToolsResult {
  const entries = fullCatalogEntries(
    registry,
    codexAppHostToolCatalog,
    includeBrowserNative,
    protectMutations,
    includeDirectGoals,
    includeDirectJobs,
    includeDirectSchedules,
  );
  return fullToolPageFromEntries(registry, entries, cursor, cursorScope, serverIdentity);
}

function fullToolPageFromEntries(
  registry: NativeToolRegistrySnapshot,
  entries: readonly FullCatalogEntry[],
  cursor: string | undefined,
  cursorScope: string,
  serverIdentity?: string,
): ListToolsResult {
  const start = fullPageStart(registry, entries, cursor, cursorScope);
  if (start >= entries.length) return { tools: [] };

  const tools: Tool[] = [];
  let serializedToolBytes = 0;
  let end = start;
  while (end < entries.length) {
    const entry = entries[end];
    if (entry === undefined) break;
    const tool =
      serverIdentity === undefined
        ? entry.tool
        : withOmniCodexServerIdentity(entry.tool, serverIdentity);
    const toolBytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
    const candidateEnd = end + 1;
    const candidateCursor =
      candidateEnd < entries.length
        ? encodeCursor(registry.revision, entry.toolId, cursorScope)
        : undefined;
    const candidateBytes =
      Buffer.byteLength('{"tools":[]}', "utf8") +
      serializedToolBytes +
      (tools.length === 0 ? 0 : tools.length) +
      toolBytes +
      (candidateCursor === undefined
        ? 0
        : Buffer.byteLength(`,"nextCursor":${JSON.stringify(candidateCursor)}`, "utf8"));
    if (tools.length > 0 && candidateBytes > OMNICODEX_FULL_CATALOG_PAGE_BYTE_BUDGET) break;
    tools.push(tool);
    serializedToolBytes += toolBytes;
    end = candidateEnd;
  }

  if (end >= entries.length) return { tools };
  const last = entries[end - 1];
  if (last === undefined) throw new Error("INVALID_FULL_CATALOG_PAGE");
  return {
    tools,
    nextCursor: encodeCursor(registry.revision, last.toolId, cursorScope),
  };
}

function actionCatalogToolPage(
  registry: NativeToolRegistrySnapshot,
  cursor: string | undefined,
  includeBrowserNative: boolean,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  protectMutations: boolean,
  includeDirectGoals: boolean,
  includeDirectJobs: boolean,
  includeDirectSchedules: boolean,
  byteBudget: number,
  serverIdentity?: string,
): ListToolsResult {
  if (cursor !== undefined) return { tools: [] };
  const entries = fullCatalogEntries(
    registry,
    codexAppHostToolCatalog,
    includeBrowserNative,
    protectMutations,
    includeDirectGoals,
    includeDirectJobs,
    includeDirectSchedules,
  );
  return actionCatalogToolPageFromEntries(entries, byteBudget, serverIdentity);
}

function actionCatalogToolPageFromEntries(
  entries: readonly FullCatalogEntry[],
  byteBudget: number,
  serverIdentity?: string,
): ListToolsResult {
  // ChatGPT has a bounded eager-action budget even though OmniCodex's native
  // registry is lossless. Reserve that budget for the native work surface and
  // the lossless routers first. Goal/job/schedule controls remain first-class
  // registry entries and are added eagerly when they fit; otherwise the same
  // exact entries remain discoverable and callable through the routers. Making
  // every standalone control mandatory used to crowd out fs_writeFile,
  // command_exec, Chrome, or Computer Use and produced the false impression
  // that those native capabilities had been removed from a conversation.
  // Discovery returns an executable call_native_tool fallback, so tools do not
  // need to become eager actions before an existing conversation can use them.
  // Expose one CUA programming identity and keep alternate CUA projections in
  // the complete catalog only. The purpose-named Chrome and browser actions
  // stay eager beside it so a web conversation asked to read the owner's
  // Chrome finds a direct tool under the name it was given.
  const nativeBrowserFamily = OMNICODEX_NATIVE_BROWSER_ACTION_FAMILIES.find(({ execute }) =>
    entries.some((entry) => entry.name === execute),
  );
  const selectedNativeBrowserActions = new Set<string>(
    nativeBrowserFamily === undefined
      ? []
      : [nativeBrowserFamily.execute, nativeBrowserFamily.reset],
  );
  const eligibleEntries = entries.filter(
    (entry) =>
      !isAccountAdministrationEntry(entry) &&
      (nativeBrowserFamily === undefined ||
        !isNativeBrowserActionCandidate(entry.name) ||
        selectedNativeBrowserActions.has(entry.name)),
  );
  const mandatory = new Set(
    eligibleEntries
      .filter(
        (entry) =>
          OMNICODEX_CHATGPT_MANDATORY_ACTIONS.has(entry.name) ||
          selectedNativeBrowserActions.has(entry.name),
      )
      .map((entry) => entry.toolId),
  );
  const selected = new Set<string>();
  let usedBytes = 0;
  for (const entry of eligibleEntries) {
    if (!mandatory.has(entry.toolId)) continue;
    selected.add(entry.toolId);
    usedBytes += actionCatalogTokenBearingBytes(entry.tool);
  }
  if (usedBytes > byteBudget) {
    throw new Error(
      `Mandatory OmniCodex action catalog descriptors exceed the configured byte budget (${usedBytes} > ${byteBudget})`,
    );
  }
  for (const entry of eligibleEntries) {
    if (selected.has(entry.toolId)) continue;
    // Entries already put the preferred native work surface first. Fill the
    // remaining budget with complete descriptors, including newly installed
    // tools, rather than treating that priority list as a permanent allowlist.
    const entryBytes = actionCatalogTokenBearingBytes(entry.tool);
    if (usedBytes + entryBytes > byteBudget) continue;
    selected.add(entry.toolId);
    usedBytes += entryBytes;
  }
  return {
    tools: eligibleEntries
      .filter((entry) => selected.has(entry.toolId))
      .map((entry) =>
        serverIdentity === undefined
          ? entry.tool
          : withOmniCodexServerIdentity(entry.tool, serverIdentity),
      ),
  };
}

/**
 * App Server `account/*` methods sign the Codex account in or out, consume
 * credits, and send billing mail. They administer the account rather than do
 * the owner's work, so they never take eager action space. They remain in the
 * complete catalog and callable through search_native_tools, call_native_tool
 * and app_server_rpc.
 */
function isAccountAdministrationEntry(entry: FullCatalogEntry): boolean {
  return entry.nativeNamespace === "app_server" && entry.nativeName.startsWith("account/");
}

function actionCatalogTokenBearingBytes(tool: Tool): number {
  return Buffer.byteLength(
    JSON.stringify({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }),
    "utf8",
  );
}

interface FullCatalogEntry {
  readonly name: string;
  readonly toolId: string;
  readonly nativeNamespace: string;
  readonly nativeName: string;
  readonly inputSchemaSha256: string;
  readonly revisionIdentity: {
    readonly kind: string;
    readonly origin: string;
    readonly route: string;
    readonly modelEffect: "none" | "model" | "unknown";
    readonly invokesModel: boolean | null;
    readonly stateEffect: "none" | "read" | "mutate";
  };
  readonly dispatchKind: "browser" | "host" | "registry" | "standalone";
  readonly dispatchName: string;
  readonly tool: Tool;
}

/**
 * Stable presentation order for the complete direct catalog. Ordering keeps
 * commonly used first-party surfaces easy to discover, but never filters,
 * samples, or changes the identity of any installed native tool. Transport
 * pagination is lossless and does not alter this global order.
 */
export const OMNICODEX_FULL_CATALOG_PRIORITY = [
  "codex_app__list_threads",
  "codex_app__read_thread",
  "codex_app__send_message_to_thread",
  "codex_app__wait_threads",
  "codex__app_server__fs_readFile",
  "codex__app_server__fs_writeFile",
  "codex__app_server__command_exec",
  "codex__app_server__fs_getMetadata",
  "codex__app_server__fs_readDirectory",
  "codex__app_server__fs_remove",
  "codex__app_server__thread_goal_get",
  "codex__app_server__thread_goal_set",
  "codex__app_server__thread_goal_clear",
  "apply_patch",
  "exec_command",
  "write_stdin",
  "codex__functions__exec",
  // Namespace tools from the installed native catalog retain their qualified
  // identities. Expose CUA itself rather than requiring a browser wrapper.
  "codex__cua_repl__js",
  "codex__cua_repl__js_reset",
  "codex__mcp__cua_repl__js",
  "codex__mcp__cua_repl__js_reset",
  "codex__node_repl__js",
  "codex__node_repl__js_reset",
  "codex__node_repl__js_add_node_module_dir",
  // These are the actual direct host-tool names exposed by the Codex
  // renderer. Keep the `mcp__...` spelling below as well because that is the
  // distinct nested name used inside functions.exec code mode.
  "node_repl__js",
  "node_repl__js_reset",
  "node_repl__js_add_node_module_dir",
  "search_native_tools",
  "call_native_tool",
  "app_server_rpc",
  "codex__desktop_lifecycle__status",
  "codex__desktop_lifecycle__ensure_running",
  "codex__desktop_lifecycle__restart",
  "browser__list_surfaces",
  "chrome__list_user_tabs",
  "chrome__control_chrome",
  "browser__control_in_app_browser",
  "codex__computer_use__list_apps",
  "codex__computer_use__list_windows",
  "codex__computer_use__get_window",
  "codex__computer_use__launch_app",
  "codex__computer_use__get_window_state",
  "codex__computer_use__click",
  "codex__computer_use__press_key",
  "codex__computer_use__type_text",
  "codex__computer_use__scroll",
  "codex__computer_use__set_value",
  "codex__computer_use__drag",
  "codex__computer_use__perform_secondary_action",
  "codex__computer_use__activate_window",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
  "view_image",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "request_plugin_install",
  "web__run",
  "update_plan",
  "codex_app__load_workspace_dependencies",
  "codex_app__open_in_codex",
  OMNICODEX_SESSION_IDENTITY_TOOL,
  OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL,
  PROTECTED_RESULT_READ_TOOL,
  LEGACY_MUTATION_STATUS_TOOL,
  OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
  "omnicodex__goal_create",
  "omnicodex__goal_get",
  "omnicodex__goal_list",
  "omnicodex__goal_claim_next_step",
  "omnicodex__goal_complete",
  "omnicodex__goal_update",
  "omnicodex__goal_delete",
  "omnicodex__job_start",
  "omnicodex__job_get",
  "omnicodex__job_list",
  "omnicodex__job_cancel",
  "omnicodex__schedule_create",
  "omnicodex__schedule_get",
  "omnicodex__schedule_list",
  "omnicodex__schedule_pause",
  "omnicodex__schedule_resume",
  "omnicodex__schedule_delete",
  "omnicodex__schedule_trigger",
  "omnicodex__schedule_runs",
] as const;

const OMNICODEX_CHATGPT_MANDATORY_ACTIONS = new Set<string>([
  "search_native_tools",
  "call_native_tool",
  "app_server_rpc",
  // This is the exact installed MCP tool used by Codex Browser.  Making its
  // native descriptor mandatory prevents a secondary adapter from replacing
  // it merely because the bounded action catalog filled up first.
  "codex__node_repl__js",
  // A local visual artifact is native multimodal input, not a reason to spin
  // up an HTTP server and consume a signed-in Chrome tab. Keep the installed
  // view_image contract directly visible in every ChatGPT action surface so
  // Web Pro can use the same path as Codex Desktop.
  "view_image",
  OMNICODEX_SESSION_IDENTITY_TOOL,
  OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL,
  PROTECTED_RESULT_READ_TOOL,
  LEGACY_MUTATION_STATUS_TOOL,
]);

const OMNICODEX_NATIVE_BROWSER_ACTION_FAMILIES = [
  {
    execute: "codex__cua_repl__js",
    reset: "codex__cua_repl__js_reset",
  },
  {
    execute: "codex__mcp__cua_repl__js",
    reset: "codex__mcp__cua_repl__js_reset",
  },
] as const;

function isNativeBrowserActionCandidate(name: string): boolean {
  return /(?:^|\.)codex__(?:mcp__)?cua_repl__(?:js|js_reset|turn_ended)$/u.test(name);
}

const FULL_CATALOG_PRIORITY_BY_NAME = new Map<string, number>(
  OMNICODEX_FULL_CATALOG_PRIORITY.map((name, index) => [name, index]),
);

/**
 * `/mcp/full` is the direct native catalog, not a compatibility front porch.
 * Every distinct host, browser-native, and registry identity remains present.
 * When identities prefer the same public name, one keeps that name and the
 * others receive deterministic identity-qualified aliases. Pro-direct
 * essentials are placed first, then the remaining sequence is deterministically
 * ordered by native namespace, native name, and input-schema digest.
 */
function fullCatalogEntries(
  registry: NativeToolRegistrySnapshot,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative: boolean,
  protectMutations: boolean,
  includeDirectGoals: boolean,
  includeDirectJobs: boolean,
  includeDirectSchedules: boolean,
): readonly FullCatalogEntry[] {
  const entries = fullNativeCatalogEntries(
    registry,
    codexAppHostToolCatalog,
    includeBrowserNative,
    protectMutations,
  ).map((entry): FullCatalogEntry => {
    const direct = isDirectSearchTool(entry);
    const tool = direct ? publicDirectTool(entry) : publicRegistryTool(entry, protectMutations);
    return {
      name: entry.exposedName,
      toolId: entry.toolId,
      nativeNamespace: entry.nativeNamespace,
      nativeName: entry.originalName,
      inputSchemaSha256: semanticDigest(tool.inputSchema),
      revisionIdentity: {
        kind: entry.kind,
        origin: direct ? entry.source : entry.origin,
        route: entry.route,
        modelEffect: entry.modelEffect,
        invokesModel: entry.invokesModel,
        stateEffect: entry.stateEffect,
      },
      dispatchKind: direct ? (entry.route === "browser_native" ? "browser" : "host") : "registry",
      dispatchName: entry.exposedName,
      tool,
    };
  });
  entries.push(sessionIdentityCatalogEntry(registry.revision));
  entries.push(browserActivityStopCatalogEntry(registry.revision));
  entries.push(protectedResultReadCatalogEntry(registry.revision));
  entries.push(legacyMutationStatusCatalogEntry(registry.revision));
  entries.push(attachLocalFileCatalogEntry(registry.revision));
  entries.push(...nativeRouterCatalogEntries(registry.revision));
  if (includeDirectGoals) {
    for (const tool of directGoalTools()) {
      const metadata = isObject(tool._meta) ? tool._meta : {};
      const omniCodexMetadata = isObject(metadata.omnicodex) ? metadata.omnicodex : {};
      const nativeName =
        typeof omniCodexMetadata.nativeName === "string" ? omniCodexMetadata.nativeName : tool.name;
      const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
      const versionedTool = publicActionTool(
        withCatalogRevision(
          {
            ...tool,
            _meta: {
              ...metadata,
              omnicodex: {
                ...omniCodexMetadata,
                toolId,
                kind: "function",
                origin: "omnicodex",
                invokesModel: false,
              },
            },
          } as Tool,
          registry.revision,
        ),
      );
      entries.push({
        name: tool.name,
        toolId,
        nativeNamespace: "omnicodex",
        nativeName,
        inputSchemaSha256: semanticDigest(versionedTool.inputSchema),
        revisionIdentity: standaloneRevisionIdentity(tool, "omnicodex_goal"),
        dispatchKind: "standalone",
        dispatchName: tool.name,
        tool: versionedTool,
      });
    }
  }
  if (includeDirectJobs) {
    for (const tool of directJobTools()) {
      const metadata = isObject(tool._meta) ? tool._meta : {};
      const omniCodexMetadata = isObject(metadata.omnicodex) ? metadata.omnicodex : {};
      const nativeName =
        typeof omniCodexMetadata.nativeName === "string" ? omniCodexMetadata.nativeName : tool.name;
      const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
      const versionedTool = publicActionTool(
        withCatalogRevision(
          {
            ...tool,
            _meta: {
              ...metadata,
              omnicodex: {
                ...omniCodexMetadata,
                toolId,
                kind: "function",
                origin: "omnicodex",
                invokesModel: false,
              },
            },
          } as Tool,
          registry.revision,
        ),
      );
      entries.push({
        name: tool.name,
        toolId,
        nativeNamespace: "omnicodex",
        nativeName,
        inputSchemaSha256: semanticDigest(versionedTool.inputSchema),
        revisionIdentity: standaloneRevisionIdentity(tool, "omnicodex_job"),
        dispatchKind: "standalone",
        dispatchName: tool.name,
        tool: versionedTool,
      });
    }
  }
  if (includeDirectSchedules) {
    for (const tool of directScheduleTools()) {
      const metadata = isObject(tool._meta) ? tool._meta : {};
      const omniCodexMetadata = isObject(metadata.omnicodex) ? metadata.omnicodex : {};
      const nativeName =
        typeof omniCodexMetadata.nativeName === "string" ? omniCodexMetadata.nativeName : tool.name;
      const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
      const versionedTool = publicActionTool(
        withCatalogRevision(
          {
            ...tool,
            _meta: {
              ...metadata,
              omnicodex: {
                ...omniCodexMetadata,
                toolId,
                kind: "function",
                origin: "omnicodex",
                invokesModel: false,
              },
            },
          } as Tool,
          registry.revision,
        ),
      );
      entries.push({
        name: tool.name,
        toolId,
        nativeNamespace: "omnicodex",
        nativeName,
        inputSchemaSha256: semanticDigest(versionedTool.inputSchema),
        revisionIdentity: standaloneRevisionIdentity(tool, "omnicodex_schedule"),
        dispatchKind: "standalone",
        dispatchName: tool.name,
        tool: versionedTool,
      });
    }
  }
  const identities = new Set<string>();
  for (const entry of entries) {
    if (identities.has(entry.toolId)) {
      throw new Error(`Duplicate first-class OmniCodex tool: ${entry.name}`);
    }
    identities.add(entry.toolId);
  }
  const namedEntries = assignUniqueFullCatalogNames(entries);
  namedEntries.sort(compareFullCatalogEntries);
  return namedEntries;
}

const MCP_TOOL_NAME_MAX_LENGTH = 128;

function assignUniqueFullCatalogNames(entries: readonly FullCatalogEntry[]): FullCatalogEntry[] {
  const claimants = [...entries].sort(
    (left, right) =>
      left.name.localeCompare(right.name, "en") ||
      fullCatalogNameClaimPriority(left) - fullCatalogNameClaimPriority(right) ||
      left.nativeNamespace.localeCompare(right.nativeNamespace, "en") ||
      left.nativeName.localeCompare(right.nativeName, "en") ||
      left.toolId.localeCompare(right.toolId, "en"),
  );
  const ownerByPreferredName = new Map<string, string>();
  for (const entry of claimants) {
    if (!ownerByPreferredName.has(entry.name)) {
      ownerByPreferredName.set(entry.name, entry.toolId);
    }
  }

  // Reserve every preferred name before assigning aliases so an alias can
  // never steal the natural public name of another native identity.
  const unavailable = new Set(ownerByPreferredName.keys());
  const assigned = new Set<string>();
  return entries.map((entry) => {
    const name =
      ownerByPreferredName.get(entry.name) === entry.toolId
        ? entry.name
        : identityQualifiedCatalogName(entry, unavailable, assigned);
    assigned.add(name);
    return name === entry.name
      ? entry
      : {
          ...entry,
          name,
          tool: { ...entry.tool, name },
        };
  });
}

function fullCatalogNameClaimPriority(entry: FullCatalogEntry): number {
  return entry.dispatchKind === "standalone"
    ? 0
    : entry.dispatchKind === "browser" || entry.dispatchKind === "host"
      ? 1
      : 2;
}

function identityQualifiedCatalogName(
  entry: FullCatalogEntry,
  unavailable: ReadonlySet<string>,
  assigned: ReadonlySet<string>,
): string {
  const identitySha256 = createHash("sha256")
    .update(entry.revisionIdentity.route, "utf8")
    .update("\0", "utf8")
    .update(entry.toolId, "utf8")
    .digest("hex");
  for (let ordinal = 0n; ; ordinal += 1n) {
    const suffix = `__${identitySha256}${ordinal === 0n ? "" : `_${ordinal.toString(10)}`}`;
    const prefixLength = Math.max(1, MCP_TOOL_NAME_MAX_LENGTH - suffix.length);
    const candidate = `${entry.name.slice(0, prefixLength)}${suffix}`;
    if (!unavailable.has(candidate) && !assigned.has(candidate)) return candidate;
  }
}

function compareFullCatalogEntries(left: FullCatalogEntry, right: FullCatalogEntry): number {
  const leftPriority = FULL_CATALOG_PRIORITY_BY_NAME.get(left.name);
  const rightPriority = FULL_CATALOG_PRIORITY_BY_NAME.get(right.name);
  if (leftPriority !== undefined || rightPriority !== undefined) {
    if (leftPriority === undefined) return 1;
    if (rightPriority === undefined) return -1;
    return leftPriority - rightPriority || left.toolId.localeCompare(right.toolId, "en");
  }
  return (
    left.nativeNamespace.localeCompare(right.nativeNamespace, "en") ||
    left.nativeName.localeCompare(right.nativeName, "en") ||
    left.inputSchemaSha256.localeCompare(right.inputSchemaSha256, "en") ||
    left.toolId.localeCompare(right.toolId, "en")
  );
}

function requireBrowserActivityStop(
  options: OmniCodexMcpServerOptions,
  context: BrowserNativeCallContext,
  args: Record<string, unknown>,
) {
  if (Object.keys(args).length !== 0)
    throw new Error("BROWSER_ACTIVITY_STOP_ARGUMENTS_MUST_BE_EMPTY");
  const ownerBinding = options.authorizationBinding;
  if (!ownerBinding || context.ownerBinding !== ownerBinding)
    throw new Error("BROWSER_ACTIVITY_STOP_AUTHENTICATED_OWNER_REQUIRED");
  const workSessionBinding = context.workSessionBinding;
  if (options.resolveDurableWorkSessionBinding === undefined || !workSessionBinding)
    throw new Error("BROWSER_ACTIVITY_STOP_DURABLE_WORK_SESSION_REQUIRED");
  const executor = options.browserNativeExecutor;
  const coordinator = options.browserActivityCoordinator;
  if (
    executor?.beginActivity === undefined ||
    executor.finishActivity === undefined ||
    executor.finishCurrentActivity === undefined ||
    coordinator?.finishCurrentActivity === undefined
  ) {
    throw new Error("BROWSER_ACTIVITY_STOP_LIFECYCLE_UNAVAILABLE");
  }
  const mutationCoordinator = options.legacyMutationCoordinator;
  if (mutationCoordinator === undefined)
    throw new Error("BROWSER_ACTIVITY_STOP_DURABLE_FENCE_REQUIRED");
  return {
    executor: executor as BrowserActivityLifecycleExecutor,
    finishCurrentActivity: coordinator.finishCurrentActivity.bind(coordinator),
    ownerBinding,
    workSessionBinding,
    mutationCoordinator,
  };
}

function browserActivityStopCatalogEntry(catalogRevision: string): FullCatalogEntry {
  const nativeName = "browser_activity_stop";
  const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
  const revisionIdentity = {
    kind: "function",
    origin: "omnicodex",
    route: "omnicodex_browser_activity",
    modelEffect: "none",
    invokesModel: false,
    stateEffect: "mutate",
  } as const;
  const tool = publicActionTool(
    withCatalogRevision(
      {
        name: OMNICODEX_BROWSER_ACTIVITY_STOP_TOOL,
        title: "Stop the current Work session's Browser activity",
        description:
          "Stop Browser activity only in the authenticated current Work session and await native cleanup. Does not claim tabs were closed or anything submitted. No identifiers accepted. Never automatically retry an unknown outcome.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        _meta: {
          omnicodex: { ...revisionIdentity, toolId, nativeName, nativeNamespace: "omnicodex" },
        },
      } as Tool,
      catalogRevision,
    ),
  );
  return {
    name: tool.name,
    toolId,
    nativeNamespace: "omnicodex",
    nativeName,
    inputSchemaSha256: semanticDigest(tool.inputSchema),
    revisionIdentity,
    dispatchKind: "standalone",
    dispatchName: tool.name,
    tool,
  };
}

function sessionIdentityCatalogEntry(catalogRevision: string): FullCatalogEntry {
  const nativeName = "session/identity";
  const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
  const tool = publicActionTool(
    withCatalogRevision(
      {
        name: OMNICODEX_SESSION_IDENTITY_TOOL,
        title: "Read the current OmniCodex work-session identity",
        description:
          "Read the current OmniCodex work-session identity and continuation handle for transport reconnection.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            workSessionBinding: { type: "string", minLength: 1 },
            continuationToken: { type: "string", minLength: 1 },
            catalogRevision: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          required: ["workSessionBinding", "continuationToken", "catalogRevision"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        _meta: {
          omnicodex: {
            toolId,
            nativeName,
            nativeNamespace: "omnicodex",
            kind: "function",
            origin: "omnicodex",
            route: "omnicodex_session",
            modelEffect: "none",
            invokesModel: false,
          },
        },
      } as Tool,
      catalogRevision,
    ),
  );
  return {
    name: tool.name,
    toolId,
    nativeNamespace: "omnicodex",
    nativeName,
    inputSchemaSha256: semanticDigest(tool.inputSchema),
    revisionIdentity: {
      kind: "function",
      origin: "omnicodex",
      route: "omnicodex_session",
      modelEffect: "none",
      invokesModel: false,
      stateEffect: "read",
    },
    dispatchKind: "standalone",
    dispatchName: tool.name,
    tool,
  };
}

function legacyMutationStatusCatalogEntry(catalogRevision: string): FullCatalogEntry {
  const nativeName = "legacy-mutation/status";
  const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
  const tool = publicActionTool(
    withCatalogRevision(legacyMutationStatusTool(toolId), catalogRevision),
  );
  return {
    name: tool.name,
    toolId,
    nativeNamespace: "omnicodex",
    nativeName,
    inputSchemaSha256: semanticDigest(tool.inputSchema),
    revisionIdentity: {
      kind: "function",
      origin: "omnicodex",
      route: "omnicodex_legacy_status",
      modelEffect: "none",
      invokesModel: false,
      stateEffect: "read",
    },
    dispatchKind: "standalone",
    dispatchName: tool.name,
    tool,
  };
}

function protectedResultReadCatalogEntry(catalogRevision: string): FullCatalogEntry {
  const nativeName = "result/read";
  const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
  const tool = publicActionTool(
    withCatalogRevision(
      {
        name: PROTECTED_RESULT_READ_TOOL,
        title: "Read a complete oversized OmniCodex result",
        description:
          "Read a verified snapshot chunk in the original approved session. Preserve expectedDigest. Follow nextOffset from 0 to null; concatenate chunks and verify the guide digest before use. end_of_snapshot is chunk EOF only.",
        inputSchema: {
          type: "object",
          properties: {
            resourceId: {
              type: "string",
              pattern: "^[A-Za-z0-9_-]{43}$",
              description: "Opaque resourceId from OMNICODEX_PROTECTED_RESULT_V1.",
            },
            offset: {
              type: "integer",
              minimum: 0,
              default: 0,
              description: "Byte offset. Use 0 first, then the exact returned nextOffset.",
            },
            expectedDigest: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
            _omnicodexSession: {
              type: "object",
              description:
                "Opaque durable retrieval binding from the protected handle's readArguments. Preserve it unchanged across transport reconnects and every subsequent chunk read.",
              properties: {
                workSessionBinding: { type: "string", minLength: 1 },
                continuationToken: { type: "string", minLength: 1 },
              },
              required: ["workSessionBinding", "continuationToken"],
              additionalProperties: false,
            },
          },
          required: ["resourceId"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            resourceId: { type: "string" },
            mimeType: { type: "string" },
            digest: { type: "string" },
            digestAlgorithm: { type: "string", const: "sha-256" },
            byteLength: { type: "integer", minimum: 0 },
            offset: { type: "integer", minimum: 0 },
            endOffset: { type: "integer", minimum: 0 },
            nextOffset: {
              anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
            },
            chunk: { type: "string" },
            snapshotIntegrity: {
              type: "string",
              const: "verified",
            },
            deliveryState: {
              type: "string",
              enum: ["partial", "end_of_snapshot"],
            },
          },
          required: [
            "schemaVersion",
            "resourceId",
            "mimeType",
            "digest",
            "digestAlgorithm",
            "byteLength",
            "offset",
            "endOffset",
            "nextOffset",
            "chunk",
          ],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        _meta: {
          omnicodex: {
            toolId,
            nativeName,
            nativeNamespace: "omnicodex",
            kind: "function",
            origin: "omnicodex",
            route: "omnicodex_result",
            modelEffect: "none",
            invokesModel: false,
          },
        },
      } as Tool,
      catalogRevision,
    ),
  );
  return {
    name: tool.name,
    toolId,
    nativeNamespace: "omnicodex",
    nativeName,
    inputSchemaSha256: semanticDigest(tool.inputSchema),
    revisionIdentity: {
      kind: "function",
      origin: "omnicodex",
      route: "omnicodex_result",
      modelEffect: "none",
      invokesModel: false,
      stateEffect: "read",
    },
    dispatchKind: "standalone",
    dispatchName: tool.name,
    tool,
  };
}

function attachLocalFileCatalogEntry(catalogRevision: string): FullCatalogEntry {
  const nativeName = "resource/attach-local-file";
  const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
  const tool = publicActionTool(
    withCatalogRevision(
      {
        name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
        title: "Attach one local file to this ChatGPT conversation",
        description:
          "Creates a downloadable attachment from an existing absolute local file and returns its resource_link.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              minLength: 1,
              description: "Absolute path of the existing local file to attach.",
            },
            omnicodexInvocationId: {
              type: "string",
              minLength: 16,
              maxLength: 128,
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
              description:
                "Stable idempotency key for this attachment operation. Reuse it when retrying the same operation.",
            },
            chatGptConversationUrl: {
              type: "string",
              minLength: 1,
              description: "Exact URL of the current ChatGPT conversation when available.",
            },
            [DIRECT_GOAL_CONTEXT_FIELD]: {
              type: "string",
              minLength: 32,
              maxLength: 2048,
              pattern: "^[A-Za-z0-9_-]+$",
              description:
                "Opaque Goal action token returned by omnicodex__goal_claim_next_step. Associates this attachment with that claimed step.",
            },
          },
          required: ["path", "omnicodexInvocationId"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            fileName: { type: "string", minLength: 1 },
            mimeType: { type: "string", minLength: 1 },
            byteLength: { type: "integer", minimum: 0 },
            digest: { type: "string", minLength: 1 },
            digestAlgorithm: { type: "string", const: "sha-256" },
          },
          required: ["fileName", "mimeType", "byteLength", "digest", "digestAlgorithm"],
          additionalProperties: false,
        },
        annotations: {
          // Creating a durable attachment snapshot changes transport state,
          // even though its source file is only read.
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        _meta: {
          omnicodex: {
            toolId,
            nativeName,
            nativeNamespace: "omnicodex",
            kind: "function",
            origin: "omnicodex",
            route: "omnicodex_resource",
            modelEffect: "none",
            invokesModel: false,
          },
        },
      } as Tool,
      catalogRevision,
    ),
  );
  return {
    name: tool.name,
    toolId,
    nativeNamespace: "omnicodex",
    nativeName,
    inputSchemaSha256: semanticDigest(tool.inputSchema),
    revisionIdentity: {
      kind: "function",
      origin: "omnicodex",
      route: "omnicodex_resource",
      modelEffect: "none",
      invokesModel: false,
      stateEffect: "mutate",
    },
    dispatchKind: "standalone",
    dispatchName: tool.name,
    tool,
  };
}

function nativeRouterCatalogEntries(catalogRevision: string): FullCatalogEntry[] {
  return nativeRouterTools().map((nativeTool) => {
    const nativeName = `router/${nativeTool.name}`;
    const toolId = firstClassToolId("function", "omnicodex", "omnicodex", nativeName);
    const metadata = isObject(nativeTool._meta) ? nativeTool._meta : {};
    const tool = publicActionTool(
      withCatalogRevision(
        {
          ...nativeTool,
          _meta: {
            ...metadata,
            omnicodex: {
              toolId,
              nativeName,
              nativeNamespace: "omnicodex",
              kind: "function",
              origin: "omnicodex",
              route: "omnicodex_router",
              modelEffect: "none",
              invokesModel: false,
            },
          },
        } as Tool,
        catalogRevision,
      ),
    );
    return {
      name: tool.name,
      toolId,
      nativeNamespace: "omnicodex",
      nativeName,
      inputSchemaSha256: semanticDigest(tool.inputSchema),
      revisionIdentity: {
        kind: "function",
        origin: "omnicodex",
        route: "omnicodex_router",
        modelEffect: "none",
        invokesModel: false,
        stateEffect: nativeTool.annotations?.readOnlyHint === true ? "read" : "mutate",
      },
      dispatchKind: "standalone",
      dispatchName: tool.name,
      tool,
    };
  });
}

function standaloneRevisionIdentity(
  tool: Tool,
  route: "omnicodex_goal" | "omnicodex_job" | "omnicodex_schedule",
): FullCatalogEntry["revisionIdentity"] {
  const readOnly = tool.annotations?.readOnlyHint === true;
  return {
    kind: "function",
    origin: "omnicodex",
    route,
    modelEffect: "none",
    invokesModel: false,
    stateEffect: readOnly ? "read" : "mutate",
  };
}

function attachmentApprovalRoute(
  attributedUrl: string | undefined,
  explicitUrl: unknown,
): string | undefined {
  if (explicitUrl === undefined) return attributedUrl;
  const normalized =
    typeof explicitUrl === "string" ? normalizeChatGptConversationUrl(explicitUrl) : undefined;
  if (normalized === undefined) {
    throw new TypeError("Attachment approval requires an exact ChatGPT conversation URL");
  }
  if (
    attributedUrl !== undefined &&
    normalizeChatGptConversationUrl(attributedUrl) !== normalized
  ) {
    throw new TypeError("Attachment approval target conflicts with the authenticated conversation");
  }
  return normalized;
}

function sessionIdentityResult(
  workSession: DirectJobWorkSessionBinding,
  catalogRevision: string,
): CallToolResult {
  const structuredContent = {
    workSessionBinding: workSession.workSessionBinding,
    continuationToken: workSession.continuationToken,
    catalogRevision,
  };
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
  return result;
}

function nativeSearchInlineControl(
  query: string,
  catalogRevision: string,
  matches: readonly Record<string, unknown>[],
): string | undefined {
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (match === undefined) return undefined;
  const executeWith = match.executeWith;
  const executeArguments = match.executeArguments;
  if (typeof executeWith !== "string" || !isObject(executeArguments)) return undefined;
  const control = {
    query,
    catalogRevision,
    toolId: match.toolId,
    name: match.name,
    executeWith,
    executeArguments,
  };
  const prefix = "OMNICODEX_NATIVE_SEARCH_EXECUTION_V1:";
  if (match.executionInputSchema !== undefined) {
    const expanded = `${prefix}${JSON.stringify({
      ...control,
      executionInputSchema: match.executionInputSchema,
    })}`;
    // Keep the compact control available for large schemas. Their complete
    // invocation contract remains in the exact search result and manifest.
    if (Buffer.byteLength(expanded, "utf8") <= 8 * 1024) return expanded;
  }
  return `${prefix}${JSON.stringify(control)}`;
}

function protectedResultReadRequest(args: Record<string, unknown>): ProtectedResultReadRequest {
  const resourceId = args.resourceId;
  if (typeof resourceId !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(resourceId)) {
    throw new TypeError("Protected result resourceId is invalid");
  }
  const offset = args.offset ?? 0;
  if (!Number.isSafeInteger(offset) || Number(offset) < 0) {
    throw new TypeError("Protected result offset must be a non-negative safe integer");
  }
  const expectedDigest = args.expectedDigest;
  if (
    expectedDigest !== undefined &&
    (typeof expectedDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(expectedDigest))
  ) {
    throw new TypeError("Protected result expectedDigest is invalid");
  }
  return {
    resourceId,
    offset: Number(offset),
    ...(typeof expectedDigest === "string" ? { expectedDigest } : {}),
  };
}

function protectedResultReadChunkResult(chunk: ProtectedResultReadChunk): CallToolResult {
  // `structuredContent` is the schema-authoritative payload. Repeating the
  // chunk in `content` more than doubled the MCP/SSE response and the Web
  // conversation DOM (a 192 KiB chunk became a ~476 KiB tool result). Keep a
  // compact text envelope for clients that render content while delivering the
  // exact chunk once through the declared output schema.
  const manifest = {
    schemaVersion: chunk.schemaVersion,
    resourceId: chunk.resourceId,
    byteLength: chunk.byteLength,
    offset: chunk.offset,
    endOffset: chunk.endOffset,
    nextOffset: chunk.nextOffset,
    ...(chunk.snapshotIntegrity === undefined
      ? {}
      : { snapshotIntegrity: chunk.snapshotIntegrity }),
    ...(chunk.deliveryState === undefined ? {} : { deliveryState: chunk.deliveryState }),
  };
  return {
    content: [
      {
        type: "text",
        text: `OMNICODEX_PROTECTED_RESULT_CHUNK_V1:${JSON.stringify(manifest)}`,
      },
    ],
    structuredContent: { ...chunk },
  };
}

function withoutWorkSessionContext(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const stripsLegacySessionArguments = omniCodexControlTool(toolName);
  if (
    !Object.hasOwn(args, "_omnicodexSession") &&
    (!stripsLegacySessionArguments ||
      (!Object.hasOwn(args, "workSessionBinding") && !Object.hasOwn(args, "continuationToken")))
  ) {
    return args;
  }
  const nativeArguments = { ...args };
  delete nativeArguments._omnicodexSession;
  if (stripsLegacySessionArguments) {
    delete nativeArguments.workSessionBinding;
    delete nativeArguments.continuationToken;
  }
  return nativeArguments;
}

function omniCodexControlTool(toolName: string): boolean {
  return (
    genericToolNames.some((name) => name === toolName) ||
    toolName === OMNICODEX_SESSION_IDENTITY_TOOL ||
    toolName === PROTECTED_RESULT_READ_TOOL ||
    toolName === LEGACY_MUTATION_STATUS_TOOL ||
    toolName === OMNICODEX_ATTACH_LOCAL_FILE_TOOL ||
    isDirectJobTool(toolName) ||
    isDirectScheduleTool(toolName) ||
    isDirectGoalTool(toolName) ||
    isBrowserNativeTool(toolName)
  );
}

function publicDirectTool(entry: DirectSearchTool): Tool {
  const metadata = isObject(entry.tool._meta) ? entry.tool._meta : {};
  const omniCodexMetadata = isObject(metadata.omnicodex) ? metadata.omnicodex : {};
  const annotationProjection = publicNativeToolAnnotations(
    entry.tool,
    entry.nativeNamespace,
    entry.originalName,
    entry.stateEffect,
  );
  const description = presentedNativeToolDescription(entry.tool, {
    nativeNamespace: entry.nativeNamespace,
    originalName: entry.originalName,
  });
  return publicActionTool({
    ...entry.tool,
    ...(annotationProjection.annotations === undefined
      ? {}
      : { annotations: annotationProjection.annotations }),
    ...(description === undefined ? {} : { description }),
    _meta: {
      ...metadata,
      omnicodex: {
        ...omniCodexMetadata,
        toolId: entry.toolId,
        nativeName: entry.originalName,
        nativeNamespace: entry.nativeNamespace,
        kind: entry.kind,
        origin: entry.source,
        route: entry.route,
        modelEffect: entry.modelEffect,
        invokesModel: entry.invokesModel,
        catalogRevision: entry.catalogRevision,
      },
    },
  } as Tool);
}

const CRITICAL_DIRECT_EXEC_TOOL = "codex__functions__exec";
const CRITICAL_CHATGPT_ACTION_TOOL = "call_native_tool";

function toolCatalogObservation(
  surface: "compat" | "full",
  registry: NativeToolRegistrySnapshot,
  cursor: string | undefined,
  result: ListToolsResult,
  criticalToolName: string,
): Omit<McpToolCatalogObservation, "correlationId"> {
  const criticalTools = result.tools.filter((tool) => tool.name === criticalToolName);
  const critical = criticalTools.length === 1 ? criticalTools[0] : undefined;
  const properties =
    critical === undefined ? undefined : objectValue(critical.inputSchema.properties);
  const required =
    critical === undefined || !Array.isArray(critical.inputSchema.required)
      ? undefined
      : critical.inputSchema.required.filter((value): value is string => typeof value === "string");
  return {
    surface,
    catalogRevision: registry.revision,
    cursorPresent: cursor !== undefined,
    nextCursorPresent: result.nextCursor !== undefined,
    toolCount: result.tools.length,
    criticalToolCount: criticalTools.length,
    ...(critical === undefined
      ? {}
      : {
          criticalToolProperties: Object.keys(properties ?? {})
            .sort((left, right) => left.localeCompare(right, "en"))
            .join(","),
          criticalToolRequired: [...(required ?? [])]
            .sort((left, right) => left.localeCompare(right, "en"))
            .join(","),
          criticalToolDescriptionSha256: semanticDigest(critical.description ?? ""),
          criticalToolInputSchemaSha256: semanticDigest(critical.inputSchema),
        }),
  };
}

function publicRegistryTool(entry: NativeToolRegistryEntry, _protectMutations: boolean): Tool {
  const description = publicRegistryToolDescription(entry);
  const annotationProjection = publicNativeToolAnnotations(
    entry.tool,
    entry.nativeNamespace,
    entry.originalName,
    entry.stateEffect,
  );
  return publicActionTool({
    ...entry.tool,
    ...(annotationProjection.annotations === undefined
      ? {}
      : { annotations: annotationProjection.annotations }),
    ...(description === undefined ? {} : { description }),
  });
}

function publicRegistryToolDescription(entry: NativeToolRegistryEntry): string | undefined {
  return presentedNativeToolDescription(entry.tool, {
    nativeNamespace: entry.nativeNamespace,
    originalName: entry.originalName,
  });
}

function fullPageStart(
  registry: NativeToolRegistrySnapshot,
  entries: readonly FullCatalogEntry[],
  cursor: string | undefined,
  cursorScope: string,
): number {
  if (cursor === undefined) return 0;
  const decoded = decodeCursor(cursor, cursorScope);
  if (decoded.revision !== registry.revision) throw new Error("CATALOG_CHANGED");
  const index = entries.findIndex((entry) => entry.toolId === decoded.lastToolId);
  if (index < 0) throw new Error("CATALOG_CHANGED");
  return index + 1;
}

function firstClassToolId(
  kind: string,
  origin: string,
  nativeNamespace: string,
  nativeName: string,
): string {
  const identity = [kind, origin, nativeNamespace, nativeName].join("\0");
  return lowercaseBase32(createHash("sha256").update(identity, "utf8").digest());
}

function lowercaseBase32(value: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let buffer = 0;
  let result = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) result += alphabet[(buffer << (5 - bits)) & 31];
  return result;
}

function encodeCursor(revision: string, lastToolId: string, cursorScope: string): string {
  const payload = Buffer.from(
    JSON.stringify({ surface: "full", revision, lastToolId }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", cursorScope).update(payload, "utf8").digest("base64url");
  return `${payload}.${signature}`;
}

function decodeCursor(
  cursor: string,
  cursorScope: string,
): { readonly revision: string; readonly lastToolId: string } {
  const parts = cursor.split(".");
  if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
    throw new Error("INVALID_CURSOR");
  }
  const [payload, suppliedSignature] = parts;
  const expectedSignature = createHmac("sha256", cursorScope).update(payload, "utf8").digest();
  let suppliedSignatureBytes: Buffer;
  try {
    suppliedSignatureBytes = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    suppliedSignatureBytes.toString("base64url") !== suppliedSignature ||
    suppliedSignatureBytes.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignatureBytes, expectedSignature)
  ) {
    throw new Error("INVALID_CURSOR");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    !isObject(value) ||
    value.surface !== "full" ||
    typeof value.revision !== "string" ||
    typeof value.lastToolId !== "string"
  ) {
    throw new Error("INVALID_CURSOR");
  }
  return { revision: value.revision, lastToolId: value.lastToolId };
}

interface InstalledSkillMatch {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly pluginId?: string;
  readonly source: "codex_app_server.skills/list";
  readonly callable: false;
}

async function searchInstalledSkills(
  appServer: AppServerRpcClient,
  query: string,
): Promise<{ readonly skillsTotalCount: number; readonly skills: readonly InstalledSkillMatch[] }> {
  // The App Server owns skill discovery. Do not treat a SKILL.md or CLI as an
  // MCP tool, and do not guess its executable from a browser surface listing.
  const response = await appServer.request<unknown>("skills/list", { forceReload: true });
  if (!isObject(response) || !Array.isArray(response.data)) {
    throw new Error("Codex skills/list returned an unsupported catalog");
  }
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/iu)
    .filter(Boolean);
  const matches = new Map<string, InstalledSkillMatch>();
  for (const group of response.data) {
    if (!isObject(group) || !Array.isArray(group.skills)) {
      throw new Error("Codex skills/list returned an unsupported skill group");
    }
    for (const item of group.skills) {
      if (!isObject(item) || typeof item.name !== "string" || typeof item.path !== "string")
        continue;
      const description = typeof item.description === "string" ? item.description : "";
      const searchable = `${item.name} ${description}`.toLowerCase();
      if (
        query !== "*" &&
        !searchable.includes(query) &&
        !(terms.length > 0 && terms.every((term) => searchable.includes(term)))
      )
        continue;
      const match: InstalledSkillMatch = {
        name: item.name,
        description: description.slice(0, 500),
        path: item.path,
        enabled: item.enabled === true,
        ...(typeof item.pluginId === "string" ? { pluginId: item.pluginId } : {}),
        source: "codex_app_server.skills/list",
        callable: false,
      };
      matches.set(`${item.name}\u0000${item.path}`, match);
    }
  }
  const sorted = [...matches.values()].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.path.localeCompare(b.path, "en"),
  );
  return { skillsTotalCount: sorted.length, skills: sorted.slice(0, 20) };
}

async function searchNativeTools(
  appServer: AppServerRpcClient,
  registry: NativeToolRegistrySnapshot,
  args: Record<string, unknown>,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative: boolean,
  protectMutations: boolean,
  includeDirectGoals: boolean,
  includeDirectJobs: boolean,
  includeDirectSchedules: boolean,
  directActionNames: ReadonlySet<string>,
): Promise<CallToolResult> {
  const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  if (query.length === 0) throw new TypeError("NATIVE_TOOL_SEARCH_QUERY_REQUIRED");
  const skillSearch =
    args.includeSkills === true ? await searchInstalledSkills(appServer, query) : undefined;
  const queryAll = query === "*";
  const queryTokens = queryAll
    ? []
    : query.split(/[^a-z0-9_.-]+/i).filter((token) => token.length > 0);
  const namespace = typeof args.namespace === "string" ? args.namespace : undefined;
  const kind = typeof args.kind === "string" ? args.kind : undefined;
  const modelEffect = typeof args.modelEffect === "string" ? args.modelEffect : undefined;
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.trunc(args.limit))
      : undefined;
  const standaloneSearchEntries = fullCatalogEntries(
    registry,
    codexAppHostToolCatalog,
    includeBrowserNative,
    protectMutations,
    includeDirectGoals,
    includeDirectJobs,
    includeDirectSchedules,
  )
    .filter((entry) => entry.dispatchKind === "standalone")
    .map((entry): DirectSearchTool => {
      const route = entry.revisionIdentity.route;
      if (!isStandaloneSearchRoute(route)) {
        throw new Error(`Unsupported standalone OmniCodex search route: ${route}`);
      }
      if (
        entry.revisionIdentity.modelEffect !== "none" ||
        entry.revisionIdentity.invokesModel !== false ||
        entry.revisionIdentity.stateEffect === "none"
      ) {
        throw new Error(`Invalid standalone OmniCodex search contract: ${entry.name}`);
      }
      return {
        direct: true,
        exposedName: entry.name,
        catalogExposedName: entry.name,
        originalName: entry.nativeName,
        kind: "function",
        tool: entry.tool,
        nativeTool: entry.tool,
        toolId: entry.toolId,
        source: entry.revisionIdentity.origin,
        nativeNamespace: entry.nativeNamespace,
        modelEffect: "none",
        invokesModel: false,
        stateEffect: entry.revisionIdentity.stateEffect,
        route,
        catalogRevision: registry.revision,
      };
    });
  const eligible = [
    ...nativeSearchEntries(
      registry,
      codexAppHostToolCatalog,
      includeBrowserNative,
      protectMutations,
    ),
    ...standaloneSearchEntries,
  ].filter((entry) => {
    if (namespace !== undefined && entry.nativeNamespace !== namespace) return false;
    if (kind !== undefined && entry.kind !== kind) return false;
    if (modelEffect !== undefined && entry.modelEffect !== modelEffect) return false;
    return true;
  });
  const exactNameMatches = queryAll
    ? []
    : eligible.filter((entry) => nativeSearchNames(entry).includes(query));
  const filtered = (
    queryAll
      ? eligible
      : exactNameMatches.length > 0
        ? exactNameMatches
        : eligible.filter((entry) => nativeSearchScore(entry, query, queryTokens) > 0)
  ).sort((left, right) => {
    if (queryAll) return 0;
    return (
      nativeSearchScore(right, query, queryTokens) - nativeSearchScore(left, query, queryTokens) ||
      left.exposedName.localeCompare(right.exposedName, "en")
    );
  });
  const filter = { query, namespace, kind, modelEffect };
  const start = searchPageStart(registry, filtered, args.cursor, filter);
  const remaining =
    limit === undefined ? filtered.slice(start) : filtered.slice(start, start + limit);
  const page: NativeSearchEntry[] = [];
  const matches: ReturnType<typeof registrySearchResult>[] = [];
  for (const entry of remaining) {
    const match = registrySearchResult(entry, directActionNames);
    const candidateMatches = [...matches, match];
    const candidateNextCursor =
      start + candidateMatches.length < filtered.length
        ? encodeSearchCursor(registry.revision, entry.toolId, filter)
        : undefined;
    const candidateBytes = Buffer.byteLength(
      JSON.stringify({
        count: candidateMatches.length,
        totalCount: filtered.length,
        query,
        tools: candidateMatches,
        catalogRevision: registry.revision,
        ...(candidateNextCursor === undefined ? {} : { nextCursor: candidateNextCursor }),
      }),
      "utf8",
    );
    if (matches.length > 0 && candidateBytes > OMNICODEX_NATIVE_SEARCH_PAGE_BYTE_BUDGET) break;
    page.push(entry);
    matches.push(match);
  }
  const last = page.at(-1);
  const nextCursor =
    start + page.length < filtered.length && last !== undefined
      ? encodeSearchCursor(registry.revision, last.toolId, filter)
      : undefined;
  const structuredContent = {
    count: matches.length,
    totalCount: filtered.length,
    query,
    tools: matches,
    ...(skillSearch === undefined ? {} : skillSearch),
    catalogRevision: registry.revision,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
  const contentManifest = {
    count: matches.length,
    totalCount: filtered.length,
    query,
    catalogRevision: registry.revision,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(skillSearch === undefined ? {} : skillSearch),
    tools: matches.map((match) => ({
      toolId: match.toolId,
      name: match.name,
      executeWith: match.executeWith,
      executeArguments: match.executeArguments,
      ...(match.executionInputSchema === undefined
        ? {}
        : { executionInputSchema: match.executionInputSchema }),
    })),
  };
  const result: CallToolResult = {
    content: [
      {
        type: "text",
        text: `OMNICODEX_NATIVE_SEARCH_V2:${JSON.stringify(contentManifest)}`,
      },
    ],
    structuredContent,
  };
  const inlineControl = nativeSearchInlineControl(query, registry.revision, matches);
  return inlineControl === undefined
    ? result
    : withProtectedResultInlineControl(result, inlineControl);
}

function isStandaloneSearchRoute(route: string): route is DirectSearchTool["route"] {
  return [
    "omnicodex_goal",
    "omnicodex_job",
    "omnicodex_resource",
    "omnicodex_result",
    "omnicodex_legacy_status",
    "omnicodex_router",
    "omnicodex_schedule",
    "omnicodex_browser_activity",
    "omnicodex_session",
  ].includes(route);
}

function nativeSearchNames(entry: NativeSearchEntry): readonly string[] {
  return [entry.exposedName, entry.catalogExposedName, entry.originalName].map((value) =>
    value.toLowerCase(),
  );
}

function nativeSearchScore(
  entry: NativeSearchEntry,
  query: string,
  tokens: readonly string[],
): number {
  const metadata = isObject(entry.tool._meta) ? entry.tool._meta.omnicodex : undefined;
  const nameText = [entry.exposedName, entry.catalogExposedName, entry.originalName]
    .join(" ")
    .toLowerCase();
  const titleText = (entry.tool.title ?? "").toLowerCase();
  const haystack = [
    nameText,
    entry.source,
    titleText,
    entry.tool.description ?? "",
    isObject(metadata) ? JSON.stringify(metadata) : "",
  ]
    .join(" ")
    .toLowerCase();
  let score = haystack.includes(query) ? 100 : 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) continue;
    score += 1;
    if (nameText.includes(token)) score += 6;
    else if (titleText.includes(token)) score += 3;
  }
  return score;
}

function searchPageStart(
  registry: NativeToolRegistrySnapshot,
  entries: readonly NativeSearchEntry[],
  cursorValue: unknown,
  filter: Record<string, unknown>,
): number {
  if (cursorValue === undefined) return 0;
  if (typeof cursorValue !== "string") throw new Error("INVALID_CURSOR");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursorValue, "base64url").toString("utf8"));
  } catch {
    throw new Error("INVALID_CURSOR");
  }
  if (
    !isObject(decoded) ||
    decoded.surface !== "compat-search" ||
    decoded.revision !== registry.revision ||
    typeof decoded.lastToolId !== "string" ||
    JSON.stringify(decoded.filter) !== JSON.stringify(filter)
  ) {
    throw new Error("CATALOG_CHANGED");
  }
  const index = entries.findIndex((entry) => entry.toolId === decoded.lastToolId);
  if (index < 0) throw new Error("CATALOG_CHANGED");
  return index + 1;
}

function encodeSearchCursor(
  revision: string,
  lastToolId: string,
  filter: Record<string, unknown>,
): string {
  return Buffer.from(
    JSON.stringify({ surface: "compat-search", revision, lastToolId, filter }),
    "utf8",
  ).toString("base64url");
}

function genericTarget(
  registry: NativeToolRegistrySnapshot,
  args: Record<string, unknown>,
  codexAppHostToolCatalog?: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative = false,
): NativeSearchEntry | undefined {
  const candidates = genericTargetCandidates(
    registry,
    args,
    codexAppHostToolCatalog,
    includeBrowserNative,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function genericTargetCandidates(
  registry: NativeToolRegistrySnapshot,
  args: Record<string, unknown>,
  codexAppHostToolCatalog?: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  includeBrowserNative = false,
): readonly NativeSearchEntry[] {
  const hasToolId = typeof args.toolId === "string" && args.toolId.length > 0;
  const hasName = typeof args.name === "string" && args.name.length > 0;
  const hasQuery = typeof args.query === "string" && args.query.trim().length > 0;
  if ([hasToolId, hasName, hasQuery].filter(Boolean).length !== 1) return [];
  const entries =
    codexAppHostToolCatalog === undefined
      ? registry.entries
      : nativeSearchEntries(registry, codexAppHostToolCatalog, includeBrowserNative, false);
  if (hasToolId) {
    const match = entries.find((item) => item.toolId === args.toolId);
    return match === undefined ? [] : [match];
  }
  if (hasName) {
    const suppliedName = String(args.name);
    const exposedExact = entries.filter((item) => item.exposedName === suppliedName);
    if (exposedExact.length > 0) return exposedExact;
    const catalogExact = entries.filter((item) => item.catalogExposedName === suppliedName);
    if (catalogExact.length > 0) return catalogExact;
    return entries.filter((item) => item.originalName === suppliedName);
  }

  const query = String(args.query).trim().toLowerCase();
  if (query === "*") return [];
  const exact = entries.filter((entry) => nativeSearchNames(entry).includes(query));
  if (exact.length > 0) return exact;
  const tokens = query.split(/[^a-z0-9_.-]+/i).filter((token) => token.length > 0);
  return entries
    .filter((entry) => nativeSearchScore(entry, query, tokens) > 0)
    .sort(
      (left, right) =>
        nativeSearchScore(right, query, tokens) - nativeSearchScore(left, query, tokens) ||
        left.exposedName.localeCompare(right.exposedName, "en"),
    );
}

function targetObservation(
  entry: NativeSearchEntry,
  callArgs: Readonly<Record<string, unknown>> = {},
  routerArguments = false,
): Pick<
  NativeToolExecutionObservation,
  | "targetToolId"
  | "targetNativeName"
  | "targetNamespace"
  | "targetRoute"
  | "modelEffect"
  | "stateEffect"
  | "requestArgumentsSha256"
  | "targetThreadIdSha256"
  | "messagePromptSha256"
  | "messageTransmissionRequested"
  | "modelOverride"
  | "reasoningOverride"
> {
  const nativeArguments = routerArguments ? genericArguments(entry, callArgs) : callArgs;
  return {
    targetToolId: entry.toolId,
    targetNativeName: entry.originalName,
    targetNamespace: entry.nativeNamespace,
    targetRoute: searchTargetObservationRoute(entry),
    modelEffect: entry.modelEffect,
    stateEffect:
      isDirectSearchTool(entry) &&
      entry.route === "browser_native" &&
      isBrowserNativeTool(entry.exposedName)
        ? browserNativeStateEffect(
            entry.exposedName,
            isObject(nativeArguments) ? nativeArguments : {},
          )
        : entry.stateEffect,
    ...privacySafeNativeRequestObservation(entry.originalName, entry.modelEffect, nativeArguments),
  };
}

function searchTargetObservationRoute(
  entry: NativeSearchEntry,
): NonNullable<NativeToolExecutionObservation["targetRoute"]> {
  switch (entry.route) {
    case "omnicodex_goal":
    case "omnicodex_browser_activity":
    case "omnicodex_job":
    case "omnicodex_resource":
    case "omnicodex_result":
    case "omnicodex_legacy_status":
    case "omnicodex_router":
    case "omnicodex_schedule":
    case "omnicodex_session":
      return "mcp_control";
    case "app_server":
    case "browser_native":
    case "codex_app_native":
    case "computer_use_native":
    case "downstream":
    case "responses":
      return entry.route;
  }
}

type PrivacySafeNativeRequestObservation = Pick<
  NativeToolExecutionObservation,
  | "requestArgumentsSha256"
  | "targetThreadIdSha256"
  | "messagePromptSha256"
  | "messageTransmissionRequested"
  | "modelOverride"
  | "reasoningOverride"
>;

/**
 * Record enough request provenance to distinguish an explicit model override
 * and a native thread transmission without retaining thread ids, prompts, or
 * any other raw native arguments in the operational log.
 */
function privacySafeNativeRequestObservation(
  nativeName: string,
  modelEffect: NativeToolRegistryEntry["modelEffect"] | undefined,
  argumentsValue: unknown,
): PrivacySafeNativeRequestObservation {
  const args = isObject(argumentsValue) ? argumentsValue : {};
  const modelOverride = settingOverridePresence(args, [
    "model",
    "modelProvider",
    "provider",
    "providerId",
  ]);
  const reasoningOverride = settingOverridePresence(args, [
    "thinking",
    "reasoningEffort",
    "reasoning_effort",
    "effort",
  ]);
  const parsedName = splitNativeIdentity(nativeName).name ?? nativeName;
  const messageTransmissionRequested = parsedName === "send_message_to_thread";
  const targetThreadIdSha256 =
    typeof args.threadId === "string" && args.threadId.length > 0
      ? semanticDigest(args.threadId)
      : undefined;
  const messagePromptSha256 =
    messageTransmissionRequested && typeof args.prompt === "string"
      ? semanticDigest(args.prompt)
      : undefined;

  return {
    requestArgumentsSha256: semanticDigest({
      present: argumentsValue !== undefined,
      value: argumentsValue,
    }),
    ...(targetThreadIdSha256 === undefined ? {} : { targetThreadIdSha256 }),
    ...(messagePromptSha256 === undefined ? {} : { messagePromptSha256 }),
    ...(messageTransmissionRequested ? { messageTransmissionRequested: true } : {}),
    ...(modelEffect === "model" || modelOverride !== "omitted" ? { modelOverride } : {}),
    ...(modelEffect === "model" || reasoningOverride !== "omitted" ? { reasoningOverride } : {}),
  };
}

function settingOverridePresence(
  args: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): NativeSettingOverridePresence {
  let blank = false;
  for (const key of keys) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) continue;
    if (typeof args[key] === "string" && args[key].trim().length === 0) {
      blank = true;
      continue;
    }
    return "explicit";
  }
  return blank ? "blank" : "omitted";
}

function resultOutcome(result: CallToolResult): NativeToolExecutionObservation["outcome"] {
  return nativeToolResultOutcome(result);
}

/**
 * Native app-server and Responses tools report process failure as structured data
 * instead of setting CallToolResult.isError.  A non-zero exit code must not
 * advance a Goal mutation step or be persisted as a successful readback.
 */
export function nativeToolResultOutcome(
  result: CallToolResult,
): NativeToolExecutionObservation["outcome"] {
  if (result.isError === true) return "tool_error";
  if (hasFailedProcessExit(result.structuredContent)) {
    return "tool_error";
  }
  return "succeeded";
}

function hasFailedProcessExit(value: unknown): boolean {
  const structured = objectValue(value);
  return [structured.exitCode, structured.exit_code].some(
    (code) => typeof code === "number" && Number.isFinite(code) && code !== 0,
  );
}

function resultSummary(
  result: CallToolResult,
): Pick<
  NativeToolExecutionObservation,
  | "modelUsage"
  | "resultContentTypes"
  | "resultSha256"
  | "errorClass"
  | "errorName"
  | "errorCode"
  | "errorDetailsSha256"
> {
  const structured = objectValue(result.structuredContent);
  const modelUsage =
    typeof structured.modelUsage === "number" &&
    Number.isFinite(structured.modelUsage) &&
    structured.modelUsage >= 0
      ? structured.modelUsage
      : undefined;
  const resultSha256 = streamingCanonicalDigest(result);
  return {
    ...(modelUsage === undefined ? {} : { modelUsage }),
    resultContentTypes: result.content.map((item) => item.type).join(","),
    ...(resultSha256 === undefined ? {} : { resultSha256 }),
    ...(result.isError === true
      ? nativeExecutionFailureSummary(objectValue(result.structuredContent).error ?? result.content)
      : {}),
  };
}

/**
 * Hash a JSON-compatible value without first materializing another complete
 * canonical string. Large text, media, and multi-item native results therefore
 * keep their full commitment without doubling their peak representation.
 */
function streamingCanonicalDigest(value: unknown): string | undefined {
  try {
    const hash = createHash("sha256");
    const ancestors = new Set<object>();
    const append = (item: unknown, arrayElement = false): void => {
      if (item === null) {
        hash.update("null", "utf8");
        return;
      }
      if (typeof item === "string") {
        hash.update(JSON.stringify(item), "utf8");
        return;
      }
      if (typeof item === "boolean") {
        hash.update(item ? "true" : "false", "utf8");
        return;
      }
      if (typeof item === "number") {
        hash.update(Number.isFinite(item) ? JSON.stringify(item) : "null", "utf8");
        return;
      }
      if (item === undefined || typeof item === "function" || typeof item === "symbol") {
        if (arrayElement) hash.update("null", "utf8");
        return;
      }
      if (typeof item === "bigint") throw new TypeError("BigInt is not JSON serializable");
      if (typeof item !== "object") throw new TypeError("Unsupported native result value");
      if (ancestors.has(item)) throw new TypeError("Circular native result value");
      ancestors.add(item);
      try {
        if (Array.isArray(item)) {
          hash.update("[", "utf8");
          for (let index = 0; index < item.length; index += 1) {
            if (index > 0) hash.update(",", "utf8");
            append(item[index], true);
          }
          hash.update("]", "utf8");
          return;
        }
        const record = item as Record<string, unknown>;
        const keys = Object.keys(record)
          .filter((key) => {
            const member = record[key];
            return (
              member !== undefined && typeof member !== "function" && typeof member !== "symbol"
            );
          })
          .sort((left, right) => left.localeCompare(right, "en"));
        hash.update("{", "utf8");
        for (let index = 0; index < keys.length; index += 1) {
          const key = keys[index] as string;
          if (index > 0) hash.update(",", "utf8");
          hash.update(JSON.stringify(key), "utf8");
          hash.update(":", "utf8");
          append(record[key]);
        }
        hash.update("}", "utf8");
      } finally {
        ancestors.delete(item);
      }
    };
    append(value);
    return hash.digest("hex");
  } catch {
    // Observation must never turn a successfully returned native result into
    // a failed tool call. Non-JSON values remain fully visible to the caller.
    return undefined;
  }
}

function nativeExecutionFailureSummary(
  error: unknown,
): Pick<
  NativeToolExecutionObservation,
  "errorClass" | "errorName" | "errorCode" | "errorDetailsSha256"
> {
  const safeError = error instanceof Error ? structuredErrorDetails(error) : error;
  const text = nativeFailureIdentityText(safeError);
  const errorName = safeErrorStringProperty(safeError, "name");
  const explicitCode = safeErrorStringProperty(safeError, "code");
  const messageCode = /(?:^|[\s"'])(([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+))(?=[:\s"']|$)/u.exec(text)?.[1];
  const normalizedErrorName = safeOperationalErrorIdentity(errorName);
  const errorCode = safeOperationalErrorIdentity(explicitCode ?? messageCode);
  return {
    errorClass: classifyNativeExecutionFailure(text),
    ...(normalizedErrorName === undefined ? {} : { errorName: normalizedErrorName }),
    ...(errorCode === undefined ? {} : { errorCode }),
    errorDetailsSha256: semanticDigest({ error: safeError }),
  };
}

/** Classify the failure, not schemas, candidates, or other recovery payloads. */
function nativeFailureIdentityText(value: unknown): string {
  if (typeof value === "string") {
    if (/^\s*[[{]/u.test(value)) {
      try {
        return nativeFailureIdentityText(JSON.parse(value));
      } catch {
        // Ordinary native error text need not be JSON.
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => isObject(item) && item.type === "text")
      .map((item) => nativeFailureIdentityText(item.text))
      .join("\n");
  }
  if (!isObject(value)) return "";
  const identity = ["name", "code", "message"]
    .map((key) => safeErrorStringProperty(value, key))
    .filter((item) => item !== undefined)
    .join("\n");
  return identity || (value.error === undefined ? "" : nativeFailureIdentityText(value.error));
}

function classifyNativeExecutionFailure(text: string): NativeExecutionErrorClass {
  if (/outcome[_\s-]*unknown/iu.test(text)) return "outcome_unknown";
  if (/timed?\s*out|timeout/iu.test(text)) return "timeout";
  if (/disconnect|broken\s*pipe|pipe\s*(?:closed|ended)|connection\s*(?:closed|reset)/iu.test(text))
    return "disconnected";
  if (/forbidden|permission|access\s*denied|\bEPERM\b|\bEACCES\b/iu.test(text))
    return "permission_denied";
  if (/unavailable|not\s+available|not\s+running|not\s+ready/iu.test(text)) return "unavailable";
  if (/invalid|ambiguous|requires?|missing|expected|unsupported/iu.test(text))
    return "invalid_request";
  if (/unknown\s+(?:omnicodex\s+)?(?:native\s+)?tool/iu.test(text)) return "unknown_tool";
  return "native_error";
}

function safeErrorStringProperty(value: unknown, property: string): string | undefined {
  if (!isObject(value)) return undefined;
  const candidate = value[property];
  return typeof candidate === "string" ? candidate : undefined;
}

function safeOperationalErrorIdentity(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z0-9_.:/-]{1,128}$/u.test(value)) return undefined;
  return value;
}

async function emitProgress(
  options: OmniCodexMcpServerOptions,
  sendNotification: (notification: {
    readonly method: "notifications/progress";
    readonly params: {
      readonly progressToken: string | number;
      readonly progress: number;
      readonly total?: number;
      readonly message: string;
    };
  }) => Promise<void>,
  input: McpRequestAttributionObservation & {
    readonly surface: "compat" | "full";
    readonly mcpToolName: string;
    readonly phase: "started" | "native" | "completed";
    readonly mcpArgumentsSha256?: string;
    readonly invocationIdentityInputs?: MutationIdentityInputPresence;
    readonly invocationIdSha256?: string;
    readonly progressToken: string | number | undefined;
    readonly progress: number;
    readonly total?: number;
    readonly message: string;
  },
): Promise<void> {
  let emitted = false;
  if (input.progressToken !== undefined) {
    emitted = await sendNotification({
      method: "notifications/progress",
      params: {
        progressToken: input.progressToken,
        progress: input.progress,
        ...(input.total === undefined ? {} : { total: input.total }),
        message: input.message,
      },
    })
      .then(() => true)
      .catch(() => false);
  }
  observeWithoutBlocking(() =>
    options.observeProgress?.({
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...requestAttributionObservation(input),
      surface: input.surface,
      mcpToolName: input.mcpToolName,
      phase: input.phase,
      ...(input.invocationIdentityInputs === undefined
        ? {}
        : { invocationIdentityInputs: input.invocationIdentityInputs }),
      ...(input.mcpArgumentsSha256 === undefined
        ? {}
        : { mcpArgumentsSha256: input.mcpArgumentsSha256 }),
      ...(input.invocationIdSha256 === undefined
        ? {}
        : { invocationIdSha256: input.invocationIdSha256 }),
      requested: input.progressToken !== undefined,
      emitted,
    }),
  );
}

/** Observability cannot gate dispatch or replace a native completion with a sink failure. */
function observeWithoutBlocking(operation: () => Promise<void> | void): void {
  try {
    void Promise.resolve(operation()).catch(() => undefined);
  } catch {
    // Synchronous sinks have the same best-effort contract as asynchronous ones.
  }
}

export function browserNativeDiagnosticObservation(
  observation: NativeToolExecutionObservation,
): Pick<
  NativeToolExecutionObservation,
  "browserExecutionStage" | "browserReturnValuePresence" | "browserDiagnosticErrorCode"
> {
  if (observation.targetRoute !== "browser_native") return {};
  const browserExecutionStage = (
    [
      "dispatch_pending",
      "runtime_setup",
      "native_dispatch",
      "native_returned",
      "runtime_recovery",
    ] as const
  ).find((stage) => stage === observation.browserExecutionStage);
  const browserDiagnosticErrorCode = BROWSER_DIAGNOSTIC_ERROR_CODES.find(
    (code) => code === observation.errorCode,
  );
  return {
    browserExecutionStage: browserExecutionStage ?? "dispatch_pending",
    browserReturnValuePresence: "unknown",
    ...(browserDiagnosticErrorCode === undefined ? {} : { browserDiagnosticErrorCode }),
  };
}

function observeExecution(
  options: OmniCodexMcpServerOptions,
  observation: NativeToolExecutionObservation,
): void {
  const diagnostics = browserNativeDiagnosticObservation(observation);
  // Native error identities can contain caller data. Keep the original error
  // in the tool response while restricting browser log identities to fixed codes.
  const { errorName, errorCode, ...withoutErrorIdentity } = observation;
  const receipt =
    observation.targetRoute === "browser_native"
      ? {
          ...withoutErrorIdentity,
          ...diagnostics,
          ...(diagnostics.browserDiagnosticErrorCode === undefined
            ? {}
            : { errorCode: diagnostics.browserDiagnosticErrorCode }),
        }
      : observation;
  observeWithoutBlocking(() => options.observeNativeToolExecution?.(receipt));
}

function observeToolCatalog(
  options: OmniCodexMcpServerOptions,
  observation: Omit<McpToolCatalogObservation, "correlationId">,
): void {
  observeWithoutBlocking(() =>
    options.observeToolCatalog?.({
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...observation,
    }),
  );
}

function observeMutationReplay(
  options: OmniCodexMcpServerOptions,
  observation: Omit<McpMutationReplayObservation, "correlationId">,
): void {
  observeWithoutBlocking(() =>
    options.observeMutationReplay?.({
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...observation,
    }),
  );
}

async function observeReadInvocation(
  options: OmniCodexMcpServerOptions,
  observation: Omit<McpReadInvocationObservation, "correlationId">,
): Promise<void> {
  observeWithoutBlocking(() =>
    options.observeReadInvocation?.({
      ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
      ...observation,
    }),
  );
}

async function callNativeTool(
  registry: NativeToolRegistrySnapshot,
  executor: NativeToolExecutor,
  responsesToolExecutor: ResponsesNativeToolExecutor | undefined,
  appServerMethodExecutor: AppServerMethodExecutor,
  scheduler: NativeExecutionScheduler,
  codexAppHostToolExecutor: CodexAppHostToolExecutor,
  codexAppHostToolCatalog: Pick<CodexAppHostToolCatalogSnapshot, "tools">,
  browserNativeExecutor: BrowserNativeToolExecutor | undefined,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onNativeProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
  beforeNativeDispatch?: () => Promise<void>,
  operationId?: string,
  callerSessionId?: string,
  browserCallContext: BrowserNativeCallContext = {},
  browserActivityCoordinator?: BrowserActivityLifecycleCoordinator,
): Promise<CallToolResult> {
  const hasToolId = typeof args.toolId === "string" && args.toolId.length > 0;
  const hasName = typeof args.name === "string" && args.name.length > 0;
  const hasQuery = typeof args.query === "string" && args.query.trim().length > 0;
  if ([hasToolId, hasName, hasQuery].filter(Boolean).length !== 1) {
    return errorResult("call_native_tool requires exactly one of toolId, name, or query");
  }
  if (
    typeof args.expectedCatalogRevision === "string" &&
    args.expectedCatalogRevision !== registry.revision
  ) {
    return errorResult("CATALOG_CHANGED");
  }
  const candidates = genericTargetCandidates(
    registry,
    args,
    codexAppHostToolCatalog,
    browserNativeExecutor !== undefined,
  );
  if (hasQuery && candidates.length > 1) {
    return errorResult("AMBIGUOUS_NATIVE_TOOL_QUERY", {
      code: "AMBIGUOUS_NATIVE_TOOL_QUERY",
      query: String(args.query),
      candidates: candidates.map((candidate) => ({
        name: candidate.exposedName,
        nativeName: candidate.originalName,
        nativeNamespace: candidate.nativeNamespace,
        title: candidate.tool.title,
        description: candidate.tool.description,
        inputSchema: candidate.tool.inputSchema,
      })),
      retryWith: "call_native_tool",
    });
  }
  const entry = candidates.length === 1 ? candidates[0] : undefined;
  if (entry === undefined) {
    return errorResult("Unknown generic native tool target");
  }
  const argumentsValue = genericArguments(entry, args);
  const ordering = isObject(args.ordering) ? args.ordering : {};
  const explicitOrdering: NativeExecutionOrdering = {
    ...(typeof ordering.threadId === "string" ? { threadId: ordering.threadId } : {}),
    ...(typeof ordering.processId === "string" ? { processId: ordering.processId } : {}),
    ...(Array.isArray(ordering.filePaths)
      ? { filePaths: ordering.filePaths.filter((item): item is string => typeof item === "string") }
      : {}),
  };
  const normalizedOrdering = mergeNativeExecutionOrdering(
    nativeExecutionOrderingFromArguments(argumentsValue),
    explicitOrdering,
  );
  const timeoutMs = numericTimeout(args.timeoutMs);
  if (isDirectSearchTool(entry)) {
    if (!isObject(argumentsValue)) {
      return errorResult(`${entry.exposedName} requires object arguments`);
    }
    if (entry.route === "browser_native") {
      if (browserNativeExecutor === undefined) {
        return errorResult("Browser native executor is unavailable");
      }
      if (!isBrowserNativeTool(entry.exposedName)) {
        return errorResult(`Unknown browser native tool ${entry.exposedName}`);
      }
      const browserToolName = entry.exposedName;
      const browserExecutionEntry = {
        ...entry,
        stateEffect: browserNativeStateEffect(browserToolName, argumentsValue),
      };
      // Keep missing exact IAB identity on the pre-dispatch side of durable
      // mutation accounting for the compatibility router as well.
      browserContextThreadId(browserToolName, argumentsValue);
      return scheduler.run(
        {
          entry: browserExecutionEntry,
          ordering: normalizedOrdering,
          timeoutMs,
          ...(operationId === undefined ? {} : { operationId }),
          ...(signal === undefined ? {} : { signal }),
          ...(beforeNativeDispatch === undefined ? {} : { beforeOperation: beforeNativeDispatch }),
          ...(isAuthoritativeBrowserResourceReadback(browserToolName, argumentsValue)
            ? { recoverUnknownResourcesWhen: successfulBrowserResourceReadback }
            : {}),
        },
        (operationSignal) =>
          callBrowserNativeTool(
            browserNativeExecutor,
            browserToolName,
            argumentsValue,
            operationSignal,
            browserCallContext,
          ),
      );
    }
    const deferNativeDispatchBoundary = entry.exposedName === "codex_app__send_message_to_thread";
    const nativeResult = await scheduler.run(
      {
        entry,
        ordering: normalizedOrdering,
        timeoutMs,
        ...(operationId === undefined ? {} : { operationId }),
        ...(signal === undefined ? {} : { signal }),
        ...(beforeNativeDispatch === undefined || deferNativeDispatchBoundary
          ? {}
          : { beforeOperation: beforeNativeDispatch }),
      },
      (operationSignal) =>
        codexAppHostToolExecutor.call(entry.exposedName, argumentsValue, {
          operationId: operationId ?? randomUUID(),
          ...(browserCallContext.contextTurnId === undefined
            ? {}
            : { callingTurnId: browserCallContext.contextTurnId }),
          ...(callerSessionId === undefined ? {} : { callerSessionId }),
          ...(operationSignal === undefined ? {} : { signal: operationSignal }),
          ...(beforeNativeDispatch === undefined || !deferNativeDispatchBoundary
            ? {}
            : { beforeNativeDispatch }),
        }),
    );
    return toCallToolResult(
      nativeResult,
      {
        tool: entry.exposedName,
        source: entry.source,
        originalName: entry.originalName,
        route: entry.route,
        modelEffect: entry.modelEffect,
        stateEffect: entry.stateEffect,
      },
      entry.tool.outputSchema,
    );
  }
  return callRegistryEntry(
    entry,
    argumentsValue,
    executor,
    responsesToolExecutor,
    appServerMethodExecutor,
    scheduler,
    normalizedOrdering,
    timeoutMs,
    signal,
    onNativeProgress,
    beforeNativeDispatch,
    operationId,
    callerSessionId,
    browserNativeExecutor,
    browserCallContext,
    browserActivityCoordinator,
  );
}

function genericArguments(entry: NativeSearchEntry, args: Record<string, unknown>): unknown {
  if (isDirectSearchTool(entry)) {
    if (Object.hasOwn(args, "input") || Object.hasOwn(args, "payload")) {
      throw new Error(`${entry.exposedName} accepts arguments`);
    }
    return isObject(args.arguments) ? args.arguments : {};
  }
  if (
    entry.route === "responses" &&
    (entry.descriptor.kind === "custom" || entry.descriptor.kind === "freeform")
  ) {
    if (typeof args.input !== "string") throw new Error(`${entry.exposedName} requires input`);
    if (Object.hasOwn(args, "arguments") || Object.hasOwn(args, "payload")) {
      throw new Error(`${entry.exposedName} accepts only input`);
    }
    return { input: args.input };
  }
  if (entry.route === "responses" && entry.descriptor.kind === "unknown") {
    if (!Object.hasOwn(args, "payload")) throw new Error(`${entry.exposedName} requires payload`);
    if (Object.hasOwn(args, "arguments") || Object.hasOwn(args, "input")) {
      throw new Error(`${entry.exposedName} accepts only payload`);
    }
    return { payload: args.payload };
  }
  if (Object.hasOwn(args, "input") || Object.hasOwn(args, "payload")) {
    throw new Error(`${entry.exposedName} accepts arguments`);
  }
  const value = Object.hasOwn(args, "arguments") ? args.arguments : {};
  return usesArgumentsWrapper(entry) ? { arguments: value } : value;
}

function usesArgumentsWrapper(entry: NativeToolRegistryEntry): boolean {
  const metadata = isObject(entry.tool._meta) ? entry.tool._meta.omnicodex : undefined;
  if (isObject(metadata) && metadata.inputSchemaTransform === "mcp_arguments_wrapper") return true;
  const schema = entry.tool.inputSchema;
  return isObject(schema) && typeof schema.type === "string" && schema.type !== "object";
}

async function callRegistryEntry(
  entry: NativeToolRegistryEntry,
  argumentsValue: unknown,
  executor: NativeToolExecutor,
  responsesToolExecutor: ResponsesNativeToolExecutor | undefined,
  appServerMethodExecutor: AppServerMethodExecutor,
  scheduler: NativeExecutionScheduler,
  ordering?: NativeExecutionOrdering,
  timeoutMs?: number,
  signal?: AbortSignal,
  onNativeProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
  beforeNativeDispatch?: () => Promise<void>,
  operationId?: string,
  sessionScopeKey?: string,
  browserNativeExecutor?: BrowserNativeToolExecutor,
  browserCallContext?: BrowserNativeCallContext,
  browserActivityCoordinator?: BrowserActivityLifecycleCoordinator,
): Promise<CallToolResult> {
  // Optional native setting overrides use omission to inherit the active
  // runtime configuration. Apply that contract at the shared registry
  // boundary so a direct action and call_native_tool cannot serialize the
  // same blank override differently. Required fields and unrelated payload
  // fields remain byte-for-byte untouched by the schema-aware normalizer.
  const normalizedArguments = omitBlankOptionalNativeSettingOverrides(
    entry.tool.inputSchema,
    argumentsValue,
  );
  const executionEntry = nativeExecutionEntryForArguments(entry, normalizedArguments);
  const effectiveOrdering = mergeNativeExecutionOrdering(
    nativeExecutionOrderingFromArguments(normalizedArguments),
    ordering,
  );
  const resolvedTimeoutMs = resolveNativeExecutionTimeout(executionEntry, timeoutMs).timeoutMs;
  const dispatch = (cleanup?: () => Promise<void>) =>
    scheduler.run(
      {
        entry: executionEntry,
        ordering: effectiveOrdering,
        timeoutMs,
        ...(operationId === undefined ? {} : { operationId }),
        signal,
        ...(beforeNativeDispatch === undefined ? {} : { beforeOperation: beforeNativeDispatch }),
        ...(isAuthoritativeCuaResourceReadback(executionEntry, normalizedArguments)
          ? { recoverUnknownResourcesWhen: successfulBrowserResourceReadback }
          : {}),
      },
      async (operationSignal) => {
        if (cleanup !== undefined) {
          await cleanup();
          return { content: [] };
        }
        switch (entry.route) {
          case "app_server":
            return appServerMethodExecutor.call(entry.descriptor, normalizedArguments, {
              ...(resolvedTimeoutMs === undefined ? {} : { timeoutMs: resolvedTimeoutMs }),
              ...(operationSignal === undefined ? {} : { signal: operationSignal }),
            });
          case "responses":
            if (responsesToolExecutor === undefined)
              throw new Error("Responses native tool executor is unavailable");
            return responsesToolExecutor.call(
              entry.descriptor,
              normalizedArguments,
              operationSignal,
            );
          case "downstream":
            if (
              isCuaNativeTool(entry.descriptor.server, entry.descriptor.originalName) &&
              browserNativeExecutor?.callCua !== undefined
            ) {
              return browserNativeExecutor.callCua(
                entry.descriptor.server,
                entry.descriptor.originalName,
                downstreamArguments(entry, normalizedArguments),
                {
                  ...browserCallContext,
                  ...(operationSignal === undefined ? {} : { signal: operationSignal }),
                },
              );
            }
            return callDownstreamTool(
              executor,
              entry.descriptor.server,
              entry.descriptor.originalName,
              downstreamArguments(entry, normalizedArguments),
              onNativeProgress,
              operationSignal,
              sessionScopeKey,
            );
        }
      },
    );
  let result: unknown;
  if (
    entry.route === "downstream" &&
    entry.descriptor.originalName === "turn_ended" &&
    isCuaNativeTool(entry.descriptor.server, entry.descriptor.originalName) &&
    browserNativeExecutor?.callCua !== undefined &&
    browserActivityCoordinator?.finishCurrentActivity !== undefined &&
    browserNativeExecutor.beginActivity !== undefined &&
    browserNativeExecutor.finishActivity !== undefined
  ) {
    await browserActivityCoordinator.finishCurrentActivity(
      browserNativeExecutor as BrowserActivityLifecycleExecutor,
      browserCallContext ?? {},
      async (cleanup) => {
        await dispatch(cleanup);
      },
    );
    result = { content: [] };
  } else {
    result = await dispatch();
  }
  return withoutRepeatedCuaDocumentation(
    executor,
    entry,
    toCallToolResult(
      result,
      {
        tool: entry.exposedName,
        source: entry.source,
        originalName: entry.originalName,
        catalogExposedName: entry.catalogExposedName,
        route: entry.route,
      },
      entry.tool.outputSchema,
    ),
    sessionScopeKey,
  );
}

function withoutRepeatedCuaDocumentation(
  executor: NativeToolExecutor,
  entry: NativeToolRegistryEntry,
  result: CallToolResult,
  documentationScopeKey?: string,
): CallToolResult {
  if (
    entry.route !== "downstream" ||
    entry.nativeNamespace.trim().toLowerCase() !== "cua_repl" ||
    entry.originalName.trim().toLowerCase().split("/").at(-1) !== "js"
  ) {
    return result;
  }
  const executorIdentity = executor.executionContextIdentity();
  const workSessionDigest =
    documentationScopeKey === undefined
      ? undefined
      : createHash("sha256").update(documentationScopeKey, "utf8").digest("hex");
  const delivered =
    workSessionDigest === undefined
      ? (deliveredCuaDocumentationByExecutor.get(executorIdentity) ?? new Set<string>())
      : (deliveredCuaDocumentationByWorkSession.get(workSessionDigest) ?? new Set<string>());
  let changed = false;
  const content = result.content.filter((item) => {
    if (
      item.type !== "text" ||
      !/^##? Computer Use\r?\n/u.test(item.text) ||
      !item.text.includes("## API")
    ) {
      return true;
    }
    const digest = createHash("sha256").update(item.text).digest("hex");
    if (delivered.has(digest)) {
      changed = true;
      return false;
    }
    delivered.add(digest);
    return true;
  });
  if (delivered.size > 0) {
    if (workSessionDigest === undefined) {
      deliveredCuaDocumentationByExecutor.set(executorIdentity, delivered);
    } else {
      deliveredCuaDocumentationByWorkSession.set(workSessionDigest, delivered);
    }
  }
  return changed ? { ...result, content } : result;
}

/**
 * CUA's JavaScript container is normally a mutation because arbitrary code can
 * click, type, navigate, or send data. Its mandatory first-call inventory probe
 * is a closed, exact exception: it only reads the enabled surfaces and is the
 * authoritative way to establish a fresh CUA session after an owner restart.
 */
function nativeExecutionEntryForArguments(
  entry: NativeToolRegistryEntry,
  argumentsValue: unknown,
): NativeToolRegistryEntry {
  return isAuthoritativeCuaResourceReadback(entry, argumentsValue)
    ? { ...entry, stateEffect: "read" }
    : entry;
}

function isAuthoritativeCuaResourceReadback(
  entry: Pick<NativeToolRegistryEntry, "nativeNamespace" | "originalName">,
  argumentsValue: unknown,
): boolean {
  if (
    entry.nativeNamespace?.trim().toLowerCase() !== "cua_repl" ||
    entry.originalName.trim().toLowerCase().split("/").at(-1) !== "js" ||
    !isObject(argumentsValue) ||
    typeof argumentsValue.code !== "string"
  ) {
    return false;
  }
  const code = argumentsValue.code.trim();
  return (
    /^await\s+cua\.getState\(\)\s*;?$/u.test(code) ||
    /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*await\s+cua\.getState\(\)\s*;?$/u.test(code)
  );
}

function downstreamArguments(
  entry: Extract<NativeToolRegistryEntry, { readonly route: "downstream" }>,
  argumentsValue: unknown,
): unknown {
  const metadata = isObject(entry.tool._meta) ? entry.tool._meta.omnicodex : undefined;
  if (isObject(metadata) && metadata.inputSchemaTransform === "mcp_arguments_wrapper") {
    if (!isObject(argumentsValue) || !Object.hasOwn(argumentsValue, "arguments"))
      throw new Error(`${entry.exposedName} requires an arguments value`);
    return argumentsValue.arguments;
  }
  const schema = entry.tool.inputSchema;
  if (isObject(schema) && typeof schema.type === "string" && schema.type !== "object") {
    if (!isObject(argumentsValue) || !Object.hasOwn(argumentsValue, "arguments"))
      throw new Error(`${entry.exposedName} requires an arguments value`);
    return argumentsValue.arguments;
  }
  return argumentsValue;
}

function registrySearchResult(
  entry: NativeSearchEntry,
  directActionNames: ReadonlySet<string>,
): Record<string, unknown> {
  const isDirect = isDirectSearchTool(entry);
  const executeDirectly =
    entry.route !== "omnicodex_legacy_status" &&
    ((isDirect &&
      (entry.route.startsWith("omnicodex_") || directActionNames.has(entry.exposedName))) ||
      (!isDirect && directActionNames.has(entry.exposedName)));
  // Attachment delivery is a standalone MCP operation with its own durable
  // invocation identity. Advertise that actual handler instead of a native
  // router target that does not implement file delivery.
  const executeWith = executeDirectly ? entry.exposedName : "call_native_tool";
  const catalogRevision = isDirect
    ? entry.catalogRevision
    : objectValue(entry.tool._meta?.omnicodex).catalogRevision;
  // Preserve the source descriptor without duplicating its schema/description.
  // Expose only changed invocation annotations separately so search agrees with
  // tools/list without silently rewriting the original native contract.
  const nativeTool = presentedNativeSearchTool(exactNativeSearchTool(entry));
  const executionInputSchema =
    entry.kind === "function" &&
    semanticDigest(entry.tool.inputSchema) !== semanticDigest(nativeTool.inputSchema ?? null)
      ? entry.tool.inputSchema
      : undefined;
  const argumentSchemaName =
    executionInputSchema === undefined ? "nativeTool.inputSchema" : "executionInputSchema";
  const invocationIdentityGuidance =
    executionInputSchema !== undefined &&
    Object.hasOwn(objectValue(executionInputSchema.properties), OMNICODEX_INVOCATION_ID)
      ? {
          omnicodexInvocationId: executeDirectly
            ? "Optional stable identity at this action's top level; reuse only for the same approved invocation. Never remint an ID to rerun UNKNOWN work."
            : "Optional stable identity at the call_native_tool wrapper top level, never inside arguments; reuse only for the same approved invocation. Never remint an ID to rerun UNKNOWN work.",
        }
      : {};
  const { annotations: executionAnnotations } = publicNativeToolAnnotations(
    entry.tool,
    entry.nativeNamespace,
    entry.originalName,
    entry.stateEffect,
  );
  const result: Record<string, unknown> = {
    toolId: entry.toolId,
    source: entry.source,
    name: entry.exposedName,
    nativeName: entry.originalName,
    nativeNamespace: entry.nativeNamespace,
    kind: entry.kind,
    modelEffect: entry.modelEffect,
    invokesModel: entry.invokesModel,
    route: isDirect ? entry.route : objectValue(entry.tool._meta?.omnicodex).route,
    catalogRevision,
    nativeTool,
    ...(executionInputSchema === undefined ? {} : { executionInputSchema }),
    ...(executionAnnotations !== undefined &&
    semanticDigest(executionAnnotations) !== semanticDigest(nativeTool.annotations ?? null)
      ? { executionAnnotations }
      : {}),
    executeWith,
    executeArguments:
      executeDirectly && entry.route !== "omnicodex_resource"
        ? {
            ...Object.fromEntries(
              schemaRequiredProperties(entry.tool.inputSchema).map((name) => [
                name,
                `Supply ${name} matching ${argumentSchemaName}.`,
              ]),
            ),
            ...invocationIdentityGuidance,
          }
        : entry.route === "omnicodex_resource"
          ? {
              path: "Supply the absolute local file path.",
              omnicodexInvocationId: "Supply one stable UUID for this attachment and its retries.",
            }
          : {
              name: entry.exposedName,
              ...invocationIdentityGuidance,
              ...(typeof catalogRevision === "string"
                ? { expectedCatalogRevision: catalogRevision }
                : {}),
              ...(entry.route === "responses" &&
              (entry.descriptor.kind === "custom" || entry.descriptor.kind === "freeform")
                ? { input: "Supply the exact freeform string here." }
                : entry.route === "responses" && entry.descriptor.kind === "unknown"
                  ? { payload: "Supply the exact native JSON payload here." }
                  : {
                      arguments:
                        executionInputSchema === undefined
                          ? "Supply a value matching inputSchema here."
                          : "Supply target arguments matching nativeTool.inputSchema here.",
                    }),
            },
  };
  if (entry.route === "downstream") result.server = entry.descriptor.server;
  if (entry.route === "app_server") result.server = "app-server";
  if (entry.route === "responses") {
    result.server = entry.descriptor.nativeNamespace ?? "responses";
  }
  return result;
}

function allFalseCatalogAnnotations(): NonNullable<Tool["annotations"]> {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  };
}

function withAllFalseCatalogAnnotations(tool: Tool): Tool {
  return {
    ...tool,
    annotations: allFalseCatalogAnnotations(),
  };
}

function presentedNativeSearchTool(tool: Record<string, unknown>): Record<string, unknown> {
  const description = typeof tool.description === "string" ? tool.description : undefined;
  const inputSchema = isObject(tool.inputSchema)
    ? presentedNativeToolInputSchema(tool.inputSchema as Tool["inputSchema"])
    : undefined;
  const parameters = isObject(tool.parameters)
    ? presentedNativeToolInputSchema(tool.parameters as Tool["inputSchema"])
    : undefined;
  const metadata = isObject(tool._meta)
    ? presentedNativeToolMetadata(tool._meta as Tool["_meta"])
    : undefined;
  return {
    ...tool,
    ...(description === undefined
      ? {}
      : { description: presentedNativeToolDescription({ description }) ?? "" }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(parameters === undefined ? {} : { parameters }),
    ...(metadata === undefined ? {} : { _meta: metadata }),
    annotations: allFalseCatalogAnnotations(),
  };
}

function exactNativeSearchTool(entry: NativeSearchEntry): Record<string, unknown> {
  if (isDirectSearchTool(entry)) {
    return structuredClone(entry.nativeTool) as unknown as Record<string, unknown>;
  }
  if (entry.route === "responses") {
    // Responses has its own native descriptor dialect (`parameters`, custom
    // input, namespace, etc.). Returning the generated MCP projection here
    // embedded the same source spec again as `_meta.omnicodex.originalSpec` and
    // could quadruple a verbose description. Search must expose the source
    // object itself; executeWith carries the separate Web wire adaptation.
    return structuredClone(entry.descriptor.nativeSpec) as Record<string, unknown>;
  }
  if (entry.route === "downstream" && entry.descriptor.nativeTool !== undefined) {
    return structuredClone(entry.descriptor.nativeTool);
  }
  return structuredClone(entry.descriptor.tool) as unknown as Record<string, unknown>;
}
async function callDownstreamTool(
  executor: NativeToolExecutor,
  server: string,
  tool: string,
  argumentsValue: unknown,
  onNativeProgress?: (event: NativeToolProgressEvent) => Promise<void> | void,
  signal?: AbortSignal,
  sessionScopeKey?: string,
): Promise<unknown> {
  if (sessionScopeKey !== undefined) {
    return executor.callInContext(
      server,
      tool,
      argumentsValue,
      undefined,
      onNativeProgress,
      undefined,
      signal,
      sessionScopeKey,
    );
  }
  return executor.call(server, tool, argumentsValue, undefined, onNativeProgress, signal);
}

async function callAppServerRpc(
  appServerMethodExecutor: AppServerMethodExecutor,
  registry: NativeToolRegistrySnapshot,
  args: Record<string, unknown>,
  scheduler: NativeExecutionScheduler,
  signal?: AbortSignal,
  beforeNativeDispatch?: () => Promise<void>,
  operationId?: string,
): Promise<CallToolResult> {
  if (typeof args.method !== "string" || args.method.length === 0) {
    return errorResult("app_server_rpc requires a non-empty method");
  }
  if (
    typeof args.expectedCatalogRevision === "string" &&
    args.expectedCatalogRevision !== registry.revision
  ) {
    return errorResult("CATALOG_CHANGED");
  }
  const entry = registry.entries.find(
    (item) => item.route === "app_server" && item.descriptor.method === args.method,
  );
  if (entry === undefined || entry.route !== "app_server") {
    return errorResult(`App Server method ${args.method} has no catalog classification`);
  }
  const timeoutMs = numericTimeout(args.timeoutMs);
  const rawParams = isObject(args.params) ? args.params : {};
  const resolvedTimeoutMs = resolveNativeExecutionTimeout(entry, timeoutMs).timeoutMs;
  const result = await scheduler.run(
    {
      entry,
      ordering: nativeExecutionOrderingFromArguments(rawParams),
      timeoutMs,
      ...(operationId === undefined ? {} : { operationId }),
      ...(signal === undefined ? {} : { signal }),
      ...(beforeNativeDispatch === undefined ? {} : { beforeOperation: beforeNativeDispatch }),
    },
    (operationSignal) =>
      appServerMethodExecutor.call(entry.descriptor, rawParams, {
        ...(resolvedTimeoutMs === undefined ? {} : { timeoutMs: resolvedTimeoutMs }),
        ...(operationSignal === undefined ? {} : { signal: operationSignal }),
      }),
  );
  return toCallToolResult(
    result,
    {
      method: args.method,
      toolId: entry.toolId,
      catalogRevision: registry.revision,
      modelEffect: entry.modelEffect,
      invokesModel: entry.modelEffect === "model",
      modelMethod: isModelInvokingAppServerMethod(args.method),
      stateEffect: entry.stateEffect,
    },
    entry.tool.outputSchema,
  );
}

function toCallToolResult(
  value: unknown,
  metadata: Record<string, unknown>,
  outputSchema?: unknown,
): CallToolResult {
  const output = outputSchema === undefined ? undefined : mcpWireOutputSchema(outputSchema);
  if (value === undefined && output !== undefined) {
    return errorResult(
      "NATIVE_TOOL_OUTPUT_SCHEMA_VIOLATION: Native tool returned undefined despite declaring a JSON output schema",
      { nativeReturnType: "undefined", outputSchema },
    );
  }
  if (isObject(value) && Array.isArray(value.content)) {
    const valueMeta = isObject(value._meta) ? value._meta : {};
    const valueOmniMeta = isObject(valueMeta.omnicodex) ? valueMeta.omnicodex : {};
    const structuredContent = normalizedStructuredContent(value, output);
    return {
      ...value,
      content: value.content as CallToolResult["content"],
      ...(structuredContent === undefined ? {} : { structuredContent }),
      ...(hasFailedProcessExit(structuredContent) ? { isError: true } : {}),
      _meta: {
        ...valueMeta,
        omnicodex: { ...valueOmniMeta, ...metadata },
      },
    };
  }
  const objectResult = isObject(value);
  const structuredContent =
    output?.enveloped === true ? { value } : objectResult ? value : undefined;
  // ChatGPT may render only content, not structuredContent, to the model.
  // Small native objects must therefore remain readable without another tool
  // call. Keep large objects single-copy in structuredContent with a bounded
  // text manifest instead of doubling an unbounded tool response.
  const readableObject = objectResult ? stringify(value) : undefined;
  const text =
    readableObject !== undefined && Buffer.byteLength(readableObject, "utf8") <= 60 * 1024
      ? readableObject
      : objectResult
        ? `OMNICODEX_STRUCTURED_RESULT_V1:${JSON.stringify({
            location: "structuredContent",
            byteLength: Buffer.byteLength(JSON.stringify(value), "utf8"),
            sha256: semanticDigest(value),
          })}`
        : stringify(value);
  return {
    content: [{ type: "text", text }],
    ...(isObject(value) && value.isError === true ? { isError: true } : {}),
    ...(structuredContent === undefined ? {} : { structuredContent }),
    ...(hasFailedProcessExit(structuredContent) ? { isError: true } : {}),
    _meta: {
      omnicodex: {
        ...metadata,
        ...(value === undefined ? { nativeReturnType: "undefined" } : {}),
      },
    },
  };
}

function normalizedStructuredContent(
  result: Record<string, unknown>,
  output: ReturnType<typeof mcpWireOutputSchema> | undefined,
): Record<string, unknown> | undefined {
  const existing = Object.hasOwn(result, "structuredContent")
    ? result.structuredContent
    : undefined;
  if (output?.enveloped !== true || result.isError === true) {
    return isObject(existing) ? existing : undefined;
  }
  if (existing !== undefined) return { value: existing };
  return { value: semanticValueFromContent(result.content) };
}

function semanticValueFromContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.length !== 1) return value;
  const only = value[0];
  if (!isObject(only) || only.type !== "text" || typeof only.text !== "string") return only;
  try {
    return JSON.parse(only.text) as unknown;
  } catch {
    return only.text;
  }
}

function withWorkSessionMetadata(
  result: CallToolResult,
  workSession: DirectJobWorkSessionBinding,
): CallToolResult {
  const resultMeta = objectValue(result._meta);
  const omniCodexMeta = objectValue(resultMeta.omnicodex);
  return {
    ...result,
    _meta: {
      ...resultMeta,
      omnicodex: {
        ...omniCodexMeta,
        workSessionBinding: workSession.workSessionBinding,
        continuationToken: workSession.continuationToken,
        journalCursor: workSession.journalCursor,
      },
    },
  };
}

/**
 * Add only compact, component-private execution state at the ChatGPT boundary.
 * The native content and structuredContent stay byte-for-byte unchanged, and
 * native result metadata is preserved. This gives Web and mobile clients a
 * durable post-reload activity row without copying large tool outputs into the
 * page DOM or exposing transport state to the model.
 */
function publicToolResult(result: CallToolResult): CallToolResult {
  const resultMeta = objectValue(result._meta);
  const omniCodex = objectValue(resultMeta.omnicodex);
  const connectionMetadata = Object.fromEntries(
    Object.entries(omniCodex).filter(
      ([key]) =>
        ![
          "tool",
          "source",
          "originalName",
          "nativeName",
          "nativeNamespace",
          "route",
          "kind",
          "origin",
          "stateEffect",
          "modelEffect",
          "invokesModel",
          "callerProvenance",
          "nativeOmnicodex",
          "originalSpec",
          "connector",
          "readOnly",
          "destructive",
          "openWorld",
          "retryClass",
          "originalAnnotations",
          "annotationCorrection",
          "executionBoundary",
          "ownerSessionMessageAuthorization",
        ].includes(key),
    ),
  );
  const {
    omnicodex: _privateMetadata,
    "omnicodex/activity": _activity,
    ...nativeMetadata
  } = resultMeta;
  return {
    ...result,
    _meta: {
      ...nativeMetadata,
      ...(Object.keys(connectionMetadata).length === 0 ? {} : { omnicodex: connectionMetadata }),
    },
  };
}

function unavailableNativeToolResult(failure: {
  readonly server: string;
  readonly toolsError: string;
}): CallToolResult {
  return errorResult(`Native MCP server ${failure.server} is unavailable: ${failure.toolsError}`, {
    code: "NATIVE_MCP_SERVER_UNAVAILABLE",
    ...failure,
  });
}

function errorResult(message: string, details?: Readonly<Record<string, unknown>>): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ...(details === undefined ? {} : { structuredContent: { error: details } }),
    ...(details === undefined
      ? {}
      : {
          _meta: {
            omnicodex: {
              error: details,
            },
          },
        }),
  };
}

function errorResultFrom(error: unknown, prefix?: string): CallToolResult {
  const message = toError(error).message;
  return errorResult(
    prefix === undefined ? message : `${prefix}: ${message}`,
    structuredErrorDetails(error),
  );
}

/** Only request-local IDs allocated under the caller's existing owner guard. */
function withLegacyMutationDiagnostics(
  result: CallToolResult,
  correlationId: string | undefined,
  operationId?: string,
): CallToolResult {
  const diagnostics = {
    ...(correlationId !== undefined && /^[a-f0-9]{32}$/u.test(correlationId)
      ? { requestId: correlationId }
      : {}),
    ...(operationId === undefined ? {} : { operationId, statusArguments: { operationId } }),
    statusTool: LEGACY_MUTATION_STATUS_TOOL,
    statusInstructions:
      operationId === undefined
        ? "Do not pass the whole mutationRecovery object as arguments. No operationId was allocated for this request; no operation lookup arguments are provided."
        : "Call statusTool with only statusArguments as its arguments. Do not pass the whole mutationRecovery object as arguments. This reads status metadata only, not the original error body, and does not authorize a retry.",
  };
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: JSON.stringify({ mutationRecovery: diagnostics }) },
    ],
    structuredContent: { ...result.structuredContent, mutationRecovery: diagnostics },
  };
}

/**
 * A correlated JSON-RPC error response is an authoritative negative outcome:
 * the App Server received the request and explicitly rejected it. Only a
 * transport failure after dispatch is ambiguous and may enter outcome_unknown.
 */
function authoritativeNativeFailureResult(error: unknown): CallToolResult | undefined {
  return error instanceof JsonlRpcError || error instanceof ComputerUseNativeResponseError
    ? errorResultFrom(error)
    : undefined;
}

function stringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    // JSON has no undefined value. A native void return must still produce a
    // valid MCP text block, not a missing text field rejected by the client.
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Native caller timeout must be a positive safe integer");
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
