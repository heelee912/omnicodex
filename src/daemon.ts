#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runBoundedShutdownSequence,
  shutdownSequenceErrors,
} from "./application/bounded-shutdown-sequence.js";
import { ChatGptForegroundActivityTracker } from "./application/chatgpt-foreground-activity-tracker.js";
import {
  chromeApprovalReceiptSynchronized,
  chromeFileApprovalResultSummary,
} from "./application/chrome-file-approval-result.js";
import { daemonLifecycleForGatewayStatus } from "./application/daemon-bootstrap-lifecycle.js";
import { isExpectedCancellationRejection } from "./application/daemon-unhandled-rejection-policy.js";
import { DesktopChatApprovalObserver } from "./application/desktop-chat-approval-observer.js";
import { DesktopChatGoalObserver } from "./application/desktop-chat-goal-observer.js";
import { recoverDesktopRuntimeUntilReady } from "./application/desktop-runtime-disconnection.js";
import { GoalContinuationController } from "./application/goal-continuation-controller.js";
import {
  CommittedRuntimeSwitchFailure,
  OmniCodexGatewayService,
  type OmniCodexThreadInventorySnapshot,
} from "./application/omnicodex-gateway-service.js";
import {
  OracleClientBindingsActionCatalogAutoRefreshCoordinator,
  type OracleClientBindingsActionCatalogAutoRefreshResult,
  oracleActionCatalogTransportsReady,
  readStableOracleActionCatalogBaseline,
} from "./application/oracle-action-catalog-auto-refresh.js";
import { OracleActiveRunRegistry } from "./application/oracle-active-run-registry.js";
import { OracleAdapterService } from "./application/oracle-adapter-service.js";
import {
  type OracleApprovalPopupEvent,
  OracleApprovalPopupWatcher,
  oracleApprovalWatcherEventRequiresTunnelRecovery,
} from "./application/oracle-approval-popup-watcher.js";
import {
  OracleConversationApprovalMirror,
  OracleMirrorLifecycle,
} from "./application/oracle-conversation-approval-mirror.js";
import { selectOracleGoalClient } from "./application/oracle-goal-client-routing.js";
import { decideOracleInteractiveActivity } from "./application/oracle-interactive-activity.js";
import {
  type OracleDaemonRuntimeStatus,
  oracleDaemonRuntimeStatus,
} from "./application/oracle-runtime-status.js";
import { JwtBearerAuthorizer } from "./infrastructure/auth/jwt-bearer-authorizer.js";
import { authorizeLocalDaemonOwner } from "./infrastructure/auth/local-daemon-owner-authorizer.js";
import {
  ChatGptActionCatalogControlClient,
  ChatGptControlPlaneHttpError,
} from "./infrastructure/chatgpt/chatgpt-action-catalog-control-client.js";
import {
  BoundedCdpSession,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
} from "./infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { normalizeChatGptConversationUrl } from "./infrastructure/chatgpt/chatgpt-conversation-route.js";
import { OracleApprovalOwnershipGuard } from "./infrastructure/chatgpt/oracle-approval-ownership-guard.js";
import { OracleChatGptServerApprovalClient } from "./infrastructure/chatgpt/oracle-chatgpt-server-approval-client.js";
import {
  OracleConversationEventSource,
  oracleConversationTurnWasStopped,
} from "./infrastructure/chatgpt/oracle-conversation-event-source.js";
import {
  assertGatewayConfigured,
  daemonControlPipe,
  getOracleClientBindings,
  getOracleRuntimeBinding,
  loadOmniCodexConfig,
  type OmniCodexDaemonState,
  type OmniCodexOracleClientBinding,
  omniCodexDataDirectory,
  selectOracleClientConfig,
  writeOmniCodexDaemonState,
} from "./infrastructure/config/omnicodex-config-store.js";
import { ensureOmniCodexInternalIntegrityKeys } from "./infrastructure/config/omnicodex-internal-integrity-key.js";
import { DirectGoalStore } from "./infrastructure/mcp/direct-goal-store.js";
import { DirectJobManager } from "./infrastructure/mcp/direct-job-mcp-tools.js";
import { DirectJobStore } from "./infrastructure/mcp/direct-job-store.js";
import { DirectScheduleStore } from "./infrastructure/mcp/direct-schedule-store.js";
import { prepareDurableMcpEventDirectoryLayout } from "./infrastructure/mcp/durable-mcp-event-directory-layout.js";
import {
  DurableMcpEventSessionNotFoundError,
  DurableMcpEventStore,
} from "./infrastructure/mcp/durable-mcp-event-store.js";
import { DurableWorkSessionStore } from "./infrastructure/mcp/durable-work-session-store.js";
import { LegacyMutationCoordinator } from "./infrastructure/mcp/legacy-mutation-coordinator.js";
import { MutationReplayStore } from "./infrastructure/mcp/mutation-replay-store.js";
import {
  browserNativeDiagnosticObservation,
  type OmniCodexFullCatalogSnapshot,
} from "./infrastructure/mcp/omnicodex-mcp-server.js";
import { OmniCodexOperationalLog } from "./infrastructure/operations/operational-log.js";
import { computeOmniCodexReleaseFingerprint } from "./infrastructure/release/release-build-fingerprint.js";
import { DurableNativeResourceLeaseCoordinator } from "./infrastructure/runtime/durable-native-resource-lease-coordinator.js";
import {
  omniCodexRuntimeInstanceId,
  prepareOmniCodexRuntimeWriteEnvironment,
  removeOmniCodexRuntimeWriteEnvironment,
} from "./infrastructure/runtime/omnicodex-runtime-write-environment.js";
import { DurableCodexAppServerRegistry } from "./infrastructure/runtime/owned-codex-app-server-registry.js";
import { structuredErrorDetails } from "./infrastructure/runtime/structured-error-details.js";
import { HashChainedActionLedger } from "./infrastructure/safety/hash-chained-action-ledger.js";
import { WindowsCodexBoundaryGuard } from "./infrastructure/safety/windows-codex-boundary-guard.js";
import {
  type ExternalTunnelStatus,
  ExternalTunnelSupervisor,
} from "./infrastructure/tunnel/external-tunnel-supervisor.js";
import {
  NgrokPublicEndpointUnavailableError,
  NgrokTunnelSupervisor,
} from "./infrastructure/tunnel/ngrok-tunnel-supervisor.js";
import {
  type DesktopChatEventObservationStatus,
  DesktopChatEventSource,
} from "./infrastructure/windows/desktop-chat-event-source.js";
import {
  readDesktopGoalBindings,
  readDesktopGoalSnapshot,
} from "./infrastructure/windows/desktop-goal-binding-reader.js";
import { configureDefaultHiddenChildActionLedger } from "./infrastructure/windows/hidden-child-process.js";
import { OracleRemoteCdpTunnelSupervisor } from "./infrastructure/windows/oracle-remote-cdp-tunnel-supervisor.js";
import { WindowsDpapiSecretStore } from "./infrastructure/windows/windows-dpapi-secret-store.js";

const config = assertGatewayConfigured(await loadOmniCodexConfig());
const trainingMode = config.runtimeMode === "training";
const oracleRuntimeBinding = getOracleRuntimeBinding(config.oracle);
const controlPipe = daemonControlPipe();
const controlToken = randomBytes(32).toString("base64url");
const instanceNonce = requiredInstanceNonce(process.env.OMNICODEX_DAEMON_INSTANCE_NONCE);
const initialAdmission = parseInitialAdmission(process.env.OMNICODEX_INITIAL_ADMISSION);
const startedAtUnixMs = Date.now();
const runtimeInstanceId = omniCodexRuntimeInstanceId({
  pid: process.pid,
  startedAtUnixMs,
  instanceNonce,
});
const releasePath = resolve(
  process.env.OMNICODEX_RELEASE_PATH ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
);
const releaseFingerprint = await computeOmniCodexReleaseFingerprint(releasePath);
const actionLedgerPath = configureDefaultHiddenChildActionLedger(
  join(omniCodexDataDirectory(), "logs", `action-ledger-${process.pid}-${startedAtUnixMs}.jsonl`),
);
const operationalLog = new OmniCodexOperationalLog();
// The daemon remains a valid recovery entrypoint even when it is launched by
// an older stable launcher whose config predates internal integrity keys.
// `ensure` preserves every existing config field and commits the opaque DPAPI
// reference before any integrity-protected durable store is opened.
const internalIntegrityKeys = await ensureOmniCodexInternalIntegrityKeys();
const directScheduleIntegrityKey = internalIntegrityKeys.derive("direct-schedule-v1");
const durableMcpEventsIntegrityKey = internalIntegrityKeys.derive("durable-mcp-events-v1");
internalIntegrityKeys.dispose();
const durableMcpEventDirectories = await prepareDurableMcpEventDirectoryLayout(
  omniCodexDataDirectory(),
);
const directGoalStore = await DirectGoalStore.open({
  dataDirectory: omniCodexDataDirectory(),
});
const directJobStore = await DirectJobStore.open({
  dataDirectory: omniCodexDataDirectory(),
});
const directJobManager = new DirectJobManager(directJobStore);
const directScheduleStore = await DirectScheduleStore.open({
  dataDirectory: omniCodexDataDirectory(),
  integrityKey: directScheduleIntegrityKey,
});
const durableWorkSessionStore = await DurableWorkSessionStore.open({
  dataDirectory: omniCodexDataDirectory(),
});
const mutationReplayStore = await MutationReplayStore.open({
  dataDirectory: omniCodexDataDirectory(),
  maxCompletedEntries: 64,
});
const legacyMutationCoordinator = await LegacyMutationCoordinator.open({
  dataDirectory: omniCodexDataDirectory(),
  // Exact request identities remain as terminal receipts after their payload
  // expires, so keeping every historical native result only inflates restart
  // memory without improving duplicate-dispatch protection.
  maxCompletedResults: 64,
});
const nativeResourceLeaseCoordinator = await DurableNativeResourceLeaseCoordinator.open({
  dataDirectory: omniCodexDataDirectory(),
  daemon: {
    pid: process.pid,
    instanceNonce,
    startedAtUnixMs,
  },
  maxCompletions: 4_096,
});
const ownedAppServerRegistry = new DurableCodexAppServerRegistry({
  dataDirectory: omniCodexDataDirectory(),
  daemon: {
    pid: process.pid,
    instanceNonce,
    startedAtUnixMs,
  },
});
let lifecycle: OmniCodexDaemonState["lifecycle"] = "starting";
let bootstrapComplete = false;
let stopping = false;
let persistRuntimeTransitionStatus = false;
let tunnelSupervisor: NgrokTunnelSupervisor | ExternalTunnelSupervisor | undefined;
let tunnelLastError: Error | undefined;
let ngrokRecoveryTask: Promise<void> | undefined;
let codexRuntimeRecoveryTask: Promise<void> | undefined;
interface OracleTransportRuntime {
  readonly binding: OmniCodexOracleClientBinding;
  startupTask?: Promise<void>;
  startupAbort?: AbortController;
  supervisor?: OracleRemoteCdpTunnelSupervisor;
  guard?: OracleApprovalOwnershipGuard;
  guardStartupTask?: Promise<void>;
  recoveryTask?: Promise<void>;
}
interface OracleBindingRuntime {
  readonly key: string;
  readonly binding: OmniCodexOracleClientBinding;
  readonly transport: OracleTransportRuntime;
  readonly mirror: OracleConversationApprovalMirror;
  readonly conversationUrls: Set<string>;
  readonly conversationActivity: Map<string, "active" | "idle">;
  readonly primary: boolean;
  watcher?: OracleApprovalPopupWatcher;
  client?: OracleChatGptServerApprovalClient;
  eventSource?: OracleConversationEventSource;
}
const oracleTransports = new Map<string, OracleTransportRuntime>();
const oracleMirrorLifecycles = new Map<string, OracleMirrorLifecycle>();
const oracleBindingRuntimes: OracleBindingRuntime[] = [];
for (const [key, binding] of Object.entries(getOracleClientBindings(config.oracle))) {
  if (!binding.enabled) continue;
  const endpoint = new URL(binding.cdpEndpoint).href;
  let transport = oracleTransports.get(endpoint);
  if (transport === undefined) {
    transport = { binding };
    oracleTransports.set(endpoint, transport);
  }
  const duplicate = oracleBindingRuntimes.find(
    (runtime) =>
      runtime.transport === transport && runtime.binding.connectorId === binding.connectorId,
  );
  if (duplicate !== undefined) continue;
  let mirrorLifecycle = oracleMirrorLifecycles.get(endpoint);
  if (mirrorLifecycle === undefined) {
    mirrorLifecycle = new OracleMirrorLifecycle(endpoint);
    oracleMirrorLifecycles.set(endpoint, mirrorLifecycle);
  }
  oracleBindingRuntimes.push({
    key,
    binding,
    transport,
    mirror: new OracleConversationApprovalMirror({
      cdpEndpoint: binding.cdpEndpoint,
      lifecycle: mirrorLifecycle,
    }),
    conversationUrls: new Set(),
    conversationActivity: new Map(),
    primary:
      binding.connectorId === oracleRuntimeBinding?.connectorId &&
      binding.cdpEndpoint === oracleRuntimeBinding?.cdpEndpoint,
  });
}
let goalContinuationController: GoalContinuationController | undefined;
let desktopApprovalObserver: DesktopChatApprovalObserver | undefined;
let desktopGoalObserver: DesktopChatGoalObserver | undefined;
let desktopChatEventSource: DesktopChatEventSource | undefined;
let oracleActionCatalogAutoRefresh:
  | OracleClientBindingsActionCatalogAutoRefreshCoordinator
  | undefined;
let oracleActionCatalogRefreshAbort: AbortController | undefined;
// This is a per-CDP-command liveness bound, not an overall approval deadline.
// A timeout fails the isolated Oracle tunnel startup attempt so the existing
// background supervisor can recycle only that tunnel and retry. The gateway,
// Codex Desktop, and the user's local Chrome remain running.
const ORACLE_APPROVAL_CDP_COMMAND_TIMEOUT_MS = 60_000;
let oracleActionCatalogScheduleTask: Promise<void> | undefined;
const oracleActiveRunRegistry =
  oracleRuntimeBinding?.enabled === true ? new OracleActiveRunRegistry() : undefined;
let persistedFields: Partial<
  Pick<
    OmniCodexDaemonState,
    "address" | "runtimePath" | "releasePath" | "tunnel" | "tunnelOwnership" | "error"
  >
> = {};
let persistStateTail: Promise<void> = Promise.resolve();
let shutdownTask: Promise<void> | undefined;

const authorizer = new JwtBearerAuthorizer({
  issuer: config.auth.issuer,
  audience: config.auth.audience,
  additionalAudiences: oauthGatewayResources(config.auth.audience, [
    config.gateway.path,
    config.gateway.fullPath,
  ]).filter((resource) => resource !== config.auth.audience),
  ...(config.auth.resource === undefined ? {} : { resource: config.auth.resource }),
  requiredScopes: config.auth.requiredScopes,
  allowedSubjects: config.auth.allowedSubjects,
  ...(config.auth.jwksUri === undefined ? {} : { jwksUri: config.auth.jwksUri }),
});
const publicMetadataOrigin = config.tunnel?.publicUrl;
const foregroundMcpActivity = new ChatGptForegroundActivityTracker();
const service = new OmniCodexGatewayService({
  createInteractiveActivityProbe: createOracleInteractiveActivityProbe,
  browserEnvironment: trainingMode ? "training" : "codex-app",
  cwd: config.projectRoot,
  host: config.gateway.host,
  port: config.gateway.port,
  path: config.gateway.path,
  fullPath: config.gateway.fullPath,
  allowedOrigins: config.gateway.allowedOrigins,
  ...(publicMetadataOrigin === undefined
    ? {}
    : {
        allowedHosts: [new URL(publicMetadataOrigin).host],
        publicMetadataOrigin,
      }),
  authorizationServerMetadata: {
    issuer: config.auth.issuer,
    authorization_endpoint: new URL("authorize", config.auth.issuer).href,
    token_endpoint: new URL("oauth/token", config.auth.issuer).href,
    registration_endpoint: new URL("oidc/register", config.auth.issuer).href,
    jwks_uri: new URL(".well-known/jwks.json", config.auth.issuer).href,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [
      "openid",
      "profile",
      "email",
      ...new Set([...config.auth.requiredScopes, "offline_access"]),
    ],
  },
  protectedResourceMetadata: {
    resource: config.auth.resource ?? config.auth.audience,
    authorization_servers: [config.auth.issuer],
    scopes_supported: [...new Set([...config.auth.requiredScopes, "offline_access"])],
    bearer_methods_supported: ["header"],
    resource_name: "OmniCodex",
  },
  directGoalStore,
  isDesktopNativeSendReady: () => desktopChatEventSource?.endpoint !== undefined,
  evaluateDesktopNativeSend: async (expression, signal) => {
    const endpoint = desktopChatEventSource?.endpoint;
    if (!endpoint) throw new Error("DESKTOP_CHAT_RUNTIME_NOT_READY");
    signal.throwIfAborted();
    const transport = new ChatGptLoopbackCdpTransport({ endpoint, allowDesktopAppTargets: true });
    const target = (await transport.listChatGptTargets(signal))
      .filter((item) => item.type === "page" && item.url === "app://-/index.html")
      .sort((left, right) => left.id.localeCompare(right.id, "en"))[0];
    if (!target) throw new Error("DESKTOP_CHAT_RENDERER_NOT_FOUND");
    const session = await BoundedCdpSession.connect(
      transport,
      {
        target,
        targetId: target.id,
        timeoutMs: null,
        factory: (url) => new WebSocket(url) as unknown as CdpWebSocketLike,
      },
      signal,
    );
    try {
      const result = (await session.command(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        signal,
        null,
      )) as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
        result?: { value?: unknown };
      };
      if (result.exceptionDetails)
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            "DESKTOP_CHAT_RENDERER_EVALUATION_FAILED",
        );
      return result.result?.value;
    } finally {
      session.close();
    }
  },
  readDesktopGoalSnapshot: async (conversationUrl, accountSourceId, signal) => {
    const endpoint = desktopChatEventSource?.endpoint;
    if (endpoint === undefined) throw new Error("DESKTOP_GOAL_BINDING_READER_NOT_READY");
    const readScope = (boundary: AbortSignal) => service.readDesktopChatScope(boundary);
    const scope = await readScope(signal);
    return service.chatAccountRequests.run(
      accountSourceId,
      (boundary) =>
        readDesktopGoalSnapshot(
          {
            endpoint,
            conversationUrl,
            accountSourceId,
            connectorIds: scope.connectorIds,
            readScope,
          },
          boundary,
        ),
      signal,
      "report",
    );
  },
  directJobManager,
  directScheduleStore,
  durableWorkSessionStore,
  durableMcpEventStoreFactory: {
    open: (binding) =>
      DurableMcpEventStore.open({
        dataDirectory: durableMcpEventDirectories.activeDirectory,
        hmacKey: durableMcpEventsIntegrityKey,
        ...binding,
      }),
    rehydrateByTransport: async (binding) => {
      let notFound: DurableMcpEventSessionNotFoundError | undefined;
      for (const dataDirectory of durableMcpEventDirectories.replayDirectories) {
        try {
          return await DurableMcpEventStore.rehydrateByTransport({
            dataDirectory,
            hmacKey: durableMcpEventsIntegrityKey,
            ...binding,
          });
        } catch (error) {
          if (!(error instanceof DurableMcpEventSessionNotFoundError)) throw error;
          notFound = error;
        }
      }
      throw notFound ?? new DurableMcpEventSessionNotFoundError();
    },
  },
  mutationReplayStore,
  legacyMutationCoordinator,
  nativeResourceLeaseCoordinator,
  ownershipRegistry: ownedAppServerRegistry,
  // Every durable Web conversation owns an independent lazy Responses runtime.
  // The native scheduler separately serializes access to the one physical
  // extension-backed Chrome runtime shared by those conversations.
  runtimeEnvironment: async () => ({
    ...(await prepareOmniCodexRuntimeWriteEnvironment({
      dataDirectory: omniCodexDataDirectory(),
      instanceId: runtimeInstanceId,
    })),
  }),
  onDiagnostic: (message) => {
    if (typeof message.method !== "string" || !message.method.startsWith("omnicodex/shutdown/"))
      return;
    void operationalLog
      .append("daemon_stopping", {
        diagnostic: message.method,
        detailsJson: JSON.stringify(message.params ?? {}),
      })
      .catch(() => undefined);
  },
  onStatusChange: async (status) => {
    if (status.lifecycle === "stopped") return;
    if (
      !persistRuntimeTransitionStatus &&
      status.lifecycle !== "ready" &&
      status.lifecycle !== "converging"
    ) {
      return;
    }
    lifecycle = daemonLifecycleForGatewayStatus(status.lifecycle, bootstrapComplete);
    await persistState(
      {
        ...(status.address === undefined ? {} : { address: status.address }),
        ...(status.candidate === undefined ? {} : { runtimePath: status.candidate.canonicalPath }),
        ...(tunnelLastError !== undefined
          ? { error: tunnelLastError.message }
          : status.lifecycle === "converging" || status.lastError === undefined
            ? {}
            : { error: status.lastError }),
      },
      bootstrapComplete && lifecycle === "ready" && tunnelLastError === undefined ? ["error"] : [],
    );
    if (bootstrapComplete && status.lifecycle === "ready") {
      scheduleOracleActionCatalogRefresh("runtime_ready");
    }
  },
  onUnexpectedRuntimeExit: (error) => {
    if (stopping || codexRuntimeRecoveryTask !== undefined) return;
    codexRuntimeRecoveryTask = recoverCodexRuntime(error).finally(() => {
      codexRuntimeRecoveryTask = undefined;
    });
  },
  nonInterferenceBoundary: new WindowsCodexBoundaryGuard({
    actionLedger: new HashChainedActionLedger(actionLedgerPath),
  }),
  authorize: async (request) => {
    const decision =
      authorizeLocalDaemonOwner({
        request,
        expectedToken: controlToken,
        resource: config.auth.resource ?? config.auth.audience,
      }) ?? (await authorizer.authorize(request));
    if (!decision.ok) {
      await operationalLog
        .append("authorization_failed", {
          remoteAddress: request.socket.remoteAddress ?? "unknown",
          status: decision.status ?? 401,
          failureCode: decision.failureCode ?? "authorization_failed_unspecified",
          ...(decision.failureClaim === undefined ? {} : { failureClaim: decision.failureClaim }),
        })
        .catch(() => undefined);
    } else if (decision.identity !== undefined) {
      await operationalLog
        .append("authorization_succeeded", {
          remoteAddress: request.socket.remoteAddress ?? "unknown",
          resource: decision.identity.resource,
          clientIdSha256: metadataDigest(decision.identity.clientId),
          subjectSha256: metadataDigest(decision.identity.subject),
        })
        .catch(() => undefined);
    }
    return decision;
  },
  observeAuthorizationServerMetadataRequest: async (observation) => {
    await operationalLog.append("oauth_discovery_observed", {
      httpMethod: observation.httpMethod,
      path: observation.path,
      status: observation.status,
    });
  },
  observeMcpRequest: async (observation) => {
    foregroundMcpActivity.complete(observation);
    await operationalLog.append("mcp_request_observed", {
      ...(observation.correlationId === undefined
        ? {}
        : { correlationId: observation.correlationId }),
      ...(observation.principalBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.principalBindingSha256)
        ? { principalBindingSha256: observation.principalBindingSha256 }
        : {}),
      ...(observation.callerProvenance === undefined
        ? {}
        : { callerProvenance: observation.callerProvenance }),
      ...(observation.openAiSessionIdentityKind === undefined
        ? {}
        : { openAiSessionIdentityKind: observation.openAiSessionIdentityKind }),
      ...(observation.chatGptConversationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.chatGptConversationIdSha256)
        ? { chatGptConversationIdSha256: observation.chatGptConversationIdSha256 }
        : {}),
      ...(observation.workSessionBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.workSessionBindingSha256)
        ? { workSessionBindingSha256: observation.workSessionBindingSha256 }
        : {}),
      ...(observation.invocationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.invocationIdSha256)
        ? { invocationIdSha256: observation.invocationIdSha256 }
        : {}),
      ...(observation.jsonRpcIdHmac === undefined
        ? {}
        : { jsonRpcIdHmac: observation.jsonRpcIdHmac }),
      ...(observation.transportIdentityDigests === undefined
        ? {}
        : { transportIdentityDigests: JSON.stringify(observation.transportIdentityDigests) }),
      httpMethod: observation.httpMethod,
      surface: observation.surface,
      ...(observation.rpcMethod === undefined ? {} : { rpcMethod: observation.rpcMethod }),
      ...(observation.uiResourceUri === undefined
        ? {}
        : { uiResourceUri: observation.uiResourceUri }),
      sessionHeaderPresent: observation.sessionHeaderPresent,
      ...(observation.protocolVersion === undefined
        ? {}
        : { protocolVersion: observation.protocolVersion }),
      ...(observation.jsonRpcIdHmac === undefined
        ? {}
        : { jsonRpcIdHmac: observation.jsonRpcIdHmac }),
      ...(observation.transportIdentityDigests === undefined
        ? {}
        : { transportIdentityDigests: JSON.stringify(observation.transportIdentityDigests) }),
      status: observation.status,
      outcome: observation.outcome,
      ...(observation.responseTermination === undefined
        ? {}
        : { responseTermination: observation.responseTermination }),
      ...(observation.responseEndedAtUnixMs === undefined
        ? {}
        : { responseEndedAtUnixMs: observation.responseEndedAtUnixMs }),
      ...(observation.requestAbortedAtUnixMs === undefined
        ? {}
        : { requestAbortedAtUnixMs: observation.requestAbortedAtUnixMs }),
      ...(observation.invocationIdentityInputs === undefined
        ? {}
        : { invocationIdentityInputs: JSON.stringify(observation.invocationIdentityInputs) }),
    });
  },
  prepareChatGptConversationRequest: async (input) => {
    wakeOracleConversation(input.chatGptConversationUrl);
  },
  observeToolCatalog: async (observation) => {
    await operationalLog.append("mcp_tool_catalog_observed", {
      ...(observation.correlationId === undefined
        ? {}
        : { correlationId: observation.correlationId }),
      ...(observation.chatGptConversationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.chatGptConversationIdSha256)
        ? { chatGptConversationIdSha256: observation.chatGptConversationIdSha256 }
        : {}),
      ...(observation.callerProvenance === undefined
        ? {}
        : { callerProvenance: observation.callerProvenance }),
      ...(observation.principalBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.principalBindingSha256)
        ? { principalBindingSha256: observation.principalBindingSha256 }
        : {}),
      ...(observation.jsonRpcIdHmac === undefined
        ? {}
        : { jsonRpcIdHmac: observation.jsonRpcIdHmac }),
      ...(observation.transportIdentityDigests === undefined
        ? {}
        : { transportIdentityDigests: JSON.stringify(observation.transportIdentityDigests) }),
      surface: observation.surface,
      catalogRevision: observation.catalogRevision,
      cursorPresent: observation.cursorPresent,
      nextCursorPresent: observation.nextCursorPresent,
      toolCount: observation.toolCount,
      criticalToolCount: observation.criticalToolCount,
      ...(observation.criticalToolProperties === undefined
        ? {}
        : { criticalToolProperties: observation.criticalToolProperties }),
      ...(observation.criticalToolRequired === undefined
        ? {}
        : { criticalToolRequired: observation.criticalToolRequired }),
      ...(observation.criticalToolDescriptionSha256 === undefined
        ? {}
        : { criticalToolDescriptionSha256: observation.criticalToolDescriptionSha256 }),
      ...(observation.criticalToolInputSchemaSha256 === undefined
        ? {}
        : { criticalToolInputSchemaSha256: observation.criticalToolInputSchemaSha256 }),
    });
    scheduleOracleActionCatalogRefresh("catalog_observed", observation.catalogRevision);
  },
  observeNativeToolExecution: async (observation) => {
    foregroundMcpActivity.attribute(observation);
    await operationalLog.append("native_tool_execution_observed", {
      ...(observation.correlationId === undefined
        ? {}
        : { correlationId: observation.correlationId }),
      ...(observation.principalBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.principalBindingSha256)
        ? { principalBindingSha256: observation.principalBindingSha256 }
        : {}),
      ...(observation.callerProvenance === undefined
        ? {}
        : { callerProvenance: observation.callerProvenance }),
      ...(observation.chatGptConversationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.chatGptConversationIdSha256)
        ? { chatGptConversationIdSha256: observation.chatGptConversationIdSha256 }
        : {}),
      ...(observation.invocationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.invocationIdSha256)
        ? { invocationIdSha256: observation.invocationIdSha256 }
        : {}),
      surface: observation.surface,
      mcpToolName: observation.mcpToolName,
      operation: observation.operation,
      ...(observation.targetToolId === undefined ? {} : { targetToolId: observation.targetToolId }),
      ...(observation.targetNativeName === undefined
        ? {}
        : { targetNativeName: observation.targetNativeName }),
      ...(observation.targetNamespace === undefined
        ? {}
        : { targetNamespace: observation.targetNamespace }),
      ...(observation.targetRoute === undefined ? {} : { targetRoute: observation.targetRoute }),
      ...(observation.modelEffect === undefined ? {} : { modelEffect: observation.modelEffect }),
      ...(observation.stateEffect === undefined ? {} : { stateEffect: observation.stateEffect }),
      ...(observation.requestArgumentsSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.requestArgumentsSha256)
        ? { requestArgumentsSha256: observation.requestArgumentsSha256 }
        : {}),
      ...(observation.targetThreadIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.targetThreadIdSha256)
        ? { targetThreadIdSha256: observation.targetThreadIdSha256 }
        : {}),
      ...(observation.messagePromptSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.messagePromptSha256)
        ? { messagePromptSha256: observation.messagePromptSha256 }
        : {}),
      ...(observation.messageTransmissionRequested === undefined
        ? {}
        : { messageTransmissionRequested: observation.messageTransmissionRequested }),
      ...(observation.modelOverride === undefined
        ? {}
        : { modelOverride: observation.modelOverride }),
      ...(observation.reasoningOverride === undefined
        ? {}
        : { reasoningOverride: observation.reasoningOverride }),
      ...(observation.errorClass === undefined ? {} : { errorClass: observation.errorClass }),
      ...(observation.errorName !== undefined &&
      /^[A-Za-z0-9_.:/-]{1,128}$/u.test(observation.errorName)
        ? { errorName: observation.errorName }
        : {}),
      ...(observation.errorCode !== undefined &&
      /^[A-Za-z0-9_.:/-]{1,128}$/u.test(observation.errorCode)
        ? { errorCode: observation.errorCode }
        : {}),
      ...(observation.errorDetailsSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.errorDetailsSha256)
        ? { errorDetailsSha256: observation.errorDetailsSha256 }
        : {}),
      ...(observation.modelUsage === undefined ? {} : { modelUsage: observation.modelUsage }),
      ...(observation.resultContentTypes === undefined
        ? {}
        : { resultContentTypes: observation.resultContentTypes }),
      ...(observation.resultSha256 !== undefined && /^[a-f0-9]{64}$/u.test(observation.resultSha256)
        ? { resultSha256: observation.resultSha256 }
        : {}),
      ...(observation.workSessionBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.workSessionBindingSha256)
        ? { workSessionBindingSha256: observation.workSessionBindingSha256 }
        : {}),
      ...(observation.resourceDigestSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.resourceDigestSha256)
        ? { resourceDigestSha256: observation.resourceDigestSha256 }
        : {}),
      outcome: observation.outcome,
      ...browserNativeDiagnosticObservation(observation),
    });
  },
  observeDynamicToolExecution: async (observation) => {
    await operationalLog.append("nested_tool_execution_observed", {
      toolName: observation.name,
      phase: observation.phase,
      ...(observation.callId === undefined
        ? {}
        : { callIdSha256: metadataDigest(observation.callId) }),
      ...(observation.threadId === undefined
        ? {}
        : { threadIdSha256: metadataDigest(observation.threadId) }),
    });
  },
  // Wake the isolated Oracle owner when the request includes an exact route.
  // An opaque ChatGPT session id is not a conversation URL; an unattributed
  // result cannot create a mirror through this callback alone.
  prepareProtectedResultDelivery: async (input) => {
    wakeOracleConversation(input.chatGptConversationUrl);
    const endpoint = desktopChatEventSource?.endpoint;
    if (endpoint !== undefined && input.correlationId !== undefined) {
      void desktopApprovalObserver
        ?.acceptResourceDelivery({
          endpoint,
          correlationId: input.correlationId,
          ...(input.chatGptConversationUrl === undefined
            ? {}
            : { chatGptConversationUrl: input.chatGptConversationUrl }),
        })
        .catch(() => undefined);
    }
  },
  observeProgress: async (observation) => {
    // Update admission state before the asynchronous log write. Goal recovery
    // must see a foreground call as active as soon as its first progress event
    // arrives, including functions.exec calls whose Chrome work is nested.
    foregroundMcpActivity.observe(observation);
    await operationalLog.append("mcp_progress_observed", {
      ...(observation.correlationId === undefined
        ? {}
        : { correlationId: observation.correlationId }),
      ...(observation.chatGptConversationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.chatGptConversationIdSha256)
        ? { chatGptConversationIdSha256: observation.chatGptConversationIdSha256 }
        : {}),
      ...(observation.callerProvenance === undefined
        ? {}
        : { callerProvenance: observation.callerProvenance }),
      ...(observation.principalBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.principalBindingSha256)
        ? { principalBindingSha256: observation.principalBindingSha256 }
        : {}),
      ...(observation.jsonRpcIdHmac === undefined
        ? {}
        : { jsonRpcIdHmac: observation.jsonRpcIdHmac }),
      ...(observation.transportIdentityDigests === undefined
        ? {}
        : { transportIdentityDigests: JSON.stringify(observation.transportIdentityDigests) }),
      surface: observation.surface,
      mcpToolName: observation.mcpToolName,
      phase: observation.phase,
      ...(observation.invocationIdentityInputs === undefined
        ? {}
        : { invocationIdentityInputs: JSON.stringify(observation.invocationIdentityInputs) }),
      ...(observation.mcpArgumentsSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.mcpArgumentsSha256)
        ? { mcpArgumentsSha256: observation.mcpArgumentsSha256 }
        : {}),
      requested: observation.requested,
      emitted: observation.emitted,
    });
  },
  observeResultDelivery: async (observation) => {
    await operationalLog.append("mcp_result_delivered", {
      ...(observation.correlationId === undefined
        ? {}
        : { correlationId: observation.correlationId }),
      surface: observation.surface,
      mcpToolName: observation.mcpToolName,
      ...(observation.workSessionBindingSha256 === undefined
        ? {}
        : { workSessionBindingSha256: observation.workSessionBindingSha256 }),
      ...(observation.callerProvenance === undefined
        ? {}
        : { callerProvenance: observation.callerProvenance }),
      ...(observation.chatGptConversationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.chatGptConversationIdSha256)
        ? { chatGptConversationIdSha256: observation.chatGptConversationIdSha256 }
        : {}),
      ...(observation.jsonRpcIdHmac === undefined
        ? {}
        : { jsonRpcIdHmac: observation.jsonRpcIdHmac }),
      ...(observation.transportIdentityDigests === undefined
        ? {}
        : { transportIdentityDigests: JSON.stringify(observation.transportIdentityDigests) }),
      contentTypes: observation.contentTypes,
      protectedResourceLinks: observation.protectedResourceLinks,
      ...(observation.protectedErrorResourceId === undefined
        ? {}
        : { protectedErrorResourceId: observation.protectedErrorResourceId }),
      ...(observation.protectedErrorDigest === undefined
        ? {}
        : { protectedErrorDigest: observation.protectedErrorDigest }),
      deliveredByteLength: observation.deliveredByteLength,
      nativeBrowserPreviewDetached: observation.nativeBrowserPreviewDetached,
      conversationTargeting:
        observation.chatGptConversationUrl === undefined
          ? "unattributed_request"
          : observation.approvalTargetSource === "tool_argument"
            ? "explicit_tool_argument"
            : "exact_request",
    });
    // prepareProtectedResultDelivery already targets this exact conversation.
    // Observing its delivery must not enqueue the same approval lookup again.
  },
  observeMutationReplay: async (observation) => {
    await operationalLog.append("mutation_replay_observed", {
      ...(observation.correlationId === undefined
        ? {}
        : { correlationId: observation.correlationId }),
      ...(observation.chatGptConversationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.chatGptConversationIdSha256)
        ? { chatGptConversationIdSha256: observation.chatGptConversationIdSha256 }
        : {}),
      ...(observation.callerProvenance === undefined
        ? {}
        : { callerProvenance: observation.callerProvenance }),
      ...(observation.principalBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.principalBindingSha256)
        ? { principalBindingSha256: observation.principalBindingSha256 }
        : {}),
      ...(observation.jsonRpcIdHmac === undefined
        ? {}
        : { jsonRpcIdHmac: observation.jsonRpcIdHmac }),
      ...(observation.transportIdentityDigests === undefined
        ? {}
        : { transportIdentityDigests: JSON.stringify(observation.transportIdentityDigests) }),
      surface: observation.surface,
      mcpToolName: observation.mcpToolName,
      ...(observation.operationId === undefined ? {} : { operationId: observation.operationId }),
      ...(observation.identityMode === undefined ? {} : { identityMode: observation.identityMode }),
      disposition: observation.disposition,
      ...(observation.invocationIdentityInputs === undefined
        ? {}
        : { invocationIdentityInputs: JSON.stringify(observation.invocationIdentityInputs) }),
      ...(observation.observedAtUnixMs === undefined
        ? {}
        : { observedAtUnixMs: observation.observedAtUnixMs }),
      ...(observation.nativeDispatchStarted === undefined
        ? {}
        : { nativeDispatchStarted: observation.nativeDispatchStarted }),
      ...(observation.requestSignalAborted === undefined
        ? {}
        : { requestSignalAborted: observation.requestSignalAborted }),
      ...(observation.cancellationSource === undefined
        ? {}
        : { cancellationSource: observation.cancellationSource }),
    });
  },
  observeReadInvocation: async (observation) => {
    foregroundMcpActivity.attribute(observation);
    await operationalLog.append("read_invocation_observed", {
      ...(observation.correlationId === undefined
        ? {}
        : { correlationId: observation.correlationId }),
      ...(observation.chatGptConversationIdSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.chatGptConversationIdSha256)
        ? { chatGptConversationIdSha256: observation.chatGptConversationIdSha256 }
        : {}),
      ...(observation.callerProvenance === undefined
        ? {}
        : { callerProvenance: observation.callerProvenance }),
      ...(observation.principalBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.principalBindingSha256)
        ? { principalBindingSha256: observation.principalBindingSha256 }
        : {}),
      ...(observation.jsonRpcIdHmac === undefined
        ? {}
        : { jsonRpcIdHmac: observation.jsonRpcIdHmac }),
      ...(observation.transportIdentityDigests === undefined
        ? {}
        : { transportIdentityDigests: JSON.stringify(observation.transportIdentityDigests) }),
      surface: observation.surface,
      mcpToolName: observation.mcpToolName,
      invocationIdSha256: observation.invocationIdSha256,
      ...(observation.workSessionBindingSha256 !== undefined &&
      /^[a-f0-9]{64}$/u.test(observation.workSessionBindingSha256)
        ? { workSessionBindingSha256: observation.workSessionBindingSha256 }
        : {}),
      targetIdentitySha256: observation.targetIdentitySha256,
      resourceDigestSha256: observation.resourceDigestSha256,
      requestFingerprintSha256: observation.requestFingerprintSha256,
      identityMode: observation.identityMode,
      disposition: observation.disposition,
    });
  },
});

function wakeOracleConversation(url: string | undefined): void {
  if (url === undefined) return;
  const observed = oracleBindingRuntimes.filter((runtime) => runtime.conversationUrls.has(url));
  const candidates =
    observed.length > 0
      ? observed
      : oracleBindingRuntimes.length === 1
        ? oracleBindingRuntimes
        : [];
  for (const runtime of candidates) runtime.watcher?.wake(url, { serverScan: false });
  // An unknown route with multiple signed-in accounts is discovered by each
  // account's existing event stream, not by sending the URL to every account.
}

function createOracleInteractiveActivityProbe() {
  let targets:
    | Array<{ runtime: OracleBindingRuntime; url: string; activeGoal: boolean }>
    | undefined;
  let index = 0;
  const active = new Set<string>();
  return async (signal: AbortSignal, locallyTrackedConversationIds: readonly string[] = []) => {
    if (targets === undefined) {
      targets = [];
      const locallyTracked = new Set(
        locallyTrackedConversationIds.map((id) => id.trim().toLocaleLowerCase("en-US")),
      );
      for (const runtime of oracleBindingRuntimes) {
        const activeGoalUrls = new Set(
          (
            await directGoalStore.continuationConversationUrls(
              runtime.client?.accountSourceId,
              runtime.binding.connectorId,
            )
          ).flatMap((rawUrl) => {
            const url = normalizeChatGptConversationUrl(rawUrl);
            return url === undefined ? [] : [url];
          }),
        );
        for (const rawUrl of runtime.conversationUrls) {
          const url = normalizeChatGptConversationUrl(rawUrl);
          if (url === undefined) throw new Error("ORACLE_INTERACTIVE_ACTIVITY_TARGET_INVALID");
          if (locallyTracked.has(new URL(url).pathname.slice(3).toLocaleLowerCase("en-US")))
            continue;
          const duplicate = targets.some(
            (target) =>
              target.url === url &&
              target.runtime.transport === runtime.transport &&
              runtime.client?.accountSourceId !== undefined &&
              target.runtime.client?.accountSourceId === runtime.client.accountSourceId,
          );
          if (!duplicate) targets.push({ runtime, url, activeGoal: activeGoalUrls.has(url) });
        }
      }
    }
    const observedConversationIds = [
      ...new Set(targets.map(({ url }) => new URL(url).pathname.slice(3))),
    ];
    while (index < targets.length) {
      signal.throwIfAborted();
      const target = targets[index];
      if (target === undefined) throw new Error("ORACLE_INTERACTIVE_ACTIVITY_TARGET_MISSING");
      const { runtime, url } = target;
      const conversationId = new URL(url).pathname.slice(3);
      // Codex Desktop owns the current task lifecycle. When that exact task is
      // available locally, use its active/idle status and avoid spending a
      // provider request merely to authorize a planned restart.
      const nativeTaskStatus = await service
        .readChatGptConversationStatus(conversationId)
        .catch(() => undefined);
      const nativeTurnActivity = runtime.conversationActivity.get(url);
      const decision = decideOracleInteractiveActivity(
        nativeTaskStatus,
        nativeTurnActivity,
        target.activeGoal,
      );
      if (decision === "active") {
        active.add(conversationId);
        index += 1;
        continue;
      }
      if (decision === "idle") {
        active.delete(conversationId);
        index += 1;
        continue;
      }
      // Historical Oracle event targets remain in memory until an exact 404
      // arrives. If Codex Desktop no longer has the task and no active Goal is
      // bound to it, there is no live conversation to protect during restart.
      // Skipping that stale target also prevents provider pacing for an old
      // URL from blocking every otherwise-idle task indefinitely.
      if (decision === "skip") {
        index += 1;
        continue;
      }
      if (runtime.client === undefined) throw new Error("ORACLE_INTERACTIVE_ACTIVITY_UNAVAILABLE");
      const result = await runtime.client.observeGoalConversation(url, signal, {
        publishObservation: false,
      });
      const observation = result.goalConversations?.find((item) => item.conversationUrl === url);
      if (observation?.current === undefined) {
        const nextScanAtUnixMs = result.nextScanAtUnixMs ?? result.rateLimit?.retryAtUnixMs;
        if (nextScanAtUnixMs !== undefined && nextScanAtUnixMs > Date.now()) {
          return { observedConversationIds, activeConversationIds: [...active], nextScanAtUnixMs };
        }
        throw new Error("ORACLE_INTERACTIVE_ACTIVITY_UNAVAILABLE");
      }
      if (
        observation.source?.kind !== "web" ||
        observation.source.accountSourceId !== runtime.client.accountSourceId
      )
        throw new Error("ORACLE_INTERACTIVE_ACTIVITY_ACCOUNT_MISMATCH");
      const current = observation.current;
      // Native end_turn is the lifecycle boundary, including failed/cancelled
      // assistant turns. Successful final is required for Goal continuation,
      // but planned restart does not require successful task completion.
      const idle = current.authorRole === "assistant" && current.endTurn === true;
      runtime.conversationActivity.set(url, idle ? "idle" : "active");
      if (!idle) active.add(conversationId);
      index += 1;
    }
    const result = { observedConversationIds, activeConversationIds: [...active] };
    // Finish the full account-paced pass before starting another idle observation.
    targets = undefined;
    index = 0;
    active.clear();
    return result;
  };
}

function readOracleRuntimeStatus(): OracleDaemonRuntimeStatus {
  const bindings = Object.fromEntries(
    oracleBindingRuntimes.map((runtime) => [
      runtime.key,
      {
        ...oracleDaemonRuntimeStatus({
          enabled: true,
          remoteTunnelConfigured: runtime.binding.remoteCdpTunnel !== undefined,
          approvalMirrorReady: true,
          approvalAutomationEnabled: !trainingMode,
          ...(runtime.transport.supervisor?.status === undefined
            ? {}
            : { remoteTunnelStatus: runtime.transport.supervisor.status }),
          ...(runtime.watcher === undefined ? {} : { approvalWatcher: runtime.watcher.status }),
        }),
        ...(runtime.eventSource === undefined
          ? {}
          : { conversationEvents: runtime.eventSource.status() }),
      },
    ]),
  );
  const primary =
    oracleBindingRuntimes.find((runtime) => runtime.primary) ?? oracleBindingRuntimes[0];
  const status =
    (primary === undefined ? undefined : bindings[primary.key]) ??
    oracleDaemonRuntimeStatus({
      enabled: false,
      remoteTunnelConfigured: false,
      approvalMirrorReady: false,
    });
  return {
    ...status,
    activity: operationalLog.activity,
    bindings,
    ready:
      oracleBindingRuntimes.length > 0 && Object.values(bindings).every((binding) => binding.ready),
  };
}

oracleActionCatalogAutoRefresh = new OracleClientBindingsActionCatalogAutoRefreshCoordinator({
  manualRefreshOnly: true,
  loadConfig: () => loadOmniCodexConfig(),
  readCatalog: () => service.readFullCatalogSnapshot(),
  refresh: runOracleActionCatalogRefresh,
  accountSourceId: (key) =>
    oracleBindingRuntimes.find((runtime) => runtime.key === key)?.client?.accountSourceId,
  accountCooldown: {
    read: (account) => service.chatAccountRequests.readCooldown(account),
    observe: (account, snapshot) => service.chatAccountRequests.observeCooldown(account, snapshot),
  },
});

let controlServer: Server | undefined;
const controlSocketsByServer = new WeakMap<Server, Set<Socket>>();

function oauthResourceForPath(audience: string, path: string): string {
  return new URL(path, new URL(audience).origin).href;
}

function oauthGatewayResources(audience: string, paths: readonly string[]): readonly string[] {
  return [...new Set(paths.map((path) => oauthResourceForPath(audience, path)))];
}

function metadataDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

try {
  await operationalLog.append("daemon_starting");
  controlServer = await startControlServer(
    controlPipe,
    controlToken,
    { pid: process.pid, instanceNonce, startedAtUnixMs },
    () => lifecycle,
    async (timeoutMs) => shutdown(0, undefined, timeoutMs),
    async (command, timeoutMs, targetRuntimePath, clientBinding, conversationUrl, signal) => {
      const boundary = signal ?? new AbortController().signal;
      if (command === "observe-goal-conversation") {
        const runtime = oracleBindingRuntimes.find((item) => item.key === clientBinding);
        if (runtime?.client === undefined || conversationUrl === undefined)
          throw new Error("ORACLE_GOAL_OBSERVATION_TARGET_UNAVAILABLE");
        const result = await runtime.client.observeGoalConversation(conversationUrl, boundary);
        return {
          goalObservation: {
            conversationUrl,
            outcome: result.outcome,
            observedGoals:
              result.goalConversations?.flatMap((item) => item.goals.map((goal) => goal.goalId)) ??
              [],
          },
        };
      }
      if (command === "begin-drain") {
        // A planned daemon restart closes only new MCP admission. Requests
        // already accepted keep running and await-drained settles them before
        // process retirement. Waiting for every observed Web conversation to
        // become idle keeps admission open forever when independent tasks are
        // legitimately active in parallel.
        return service.beginDrain();
      }
      if (command === "await-drained") return service.awaitDrained(timeoutMs);
      if (command === "catalog-baseline") {
        return { catalogBaseline: await service.readFullCatalogSnapshot() };
      }
      if (command === "refresh-action-catalog") {
        if (oracleActionCatalogRefreshTransportsReady()) {
          // The transport can become ready before a queued readiness callback
          // updates the coordinator. Reconcile the live transport here so an
          // explicit operator refresh never needs a second identical request.
          await oracleActionCatalogAutoRefresh.markEndpointReady();
        }
        return {
          actionCatalog: await oracleActionCatalogAutoRefresh.synchronize(
            "manual_refresh",
            undefined,
            clientBinding,
          ),
        };
      }
      if (command === "thread-inventory") {
        return service.readThreadInventory();
      }
      if (command === "desktop-chat-events") {
        return { desktopChatEvents: await service.inspectDesktopChatEvents() };
      }
      if (command === "oracle-runtime-status") {
        return {
          oracle: readOracleRuntimeStatus(),
        };
      }
      if (command === "switch-runtime") {
        if (targetRuntimePath === undefined) throw new Error("Runtime switch target is required");
        const previousRuntimePath = service.status.candidate?.canonicalPath ?? "unknown";
        await operationalLog.append("runtime_switch_starting", {
          previousRuntimePath,
          targetRuntimePath,
        });
        persistRuntimeTransitionStatus = true;
        try {
          const switched = await service.switchRuntime(targetRuntimePath, timeoutMs);
          if (switched.candidate === undefined)
            throw new Error("Switched runtime omitted its candidate identity");
          await persistState({ runtimePath: switched.candidate.canonicalPath });
          await operationalLog.append("runtime_switch_completed", {
            previousRuntimePath,
            runtimePath: switched.candidate.canonicalPath,
            observationMs: 600_000,
          });
          const admission = service.resumeAdmission();
          return { ...admission, runtimePath: switched.candidate.canonicalPath };
        } catch (error) {
          const reasonCode = runtimeSwitchFailureCode(error);
          if (error instanceof CommittedRuntimeSwitchFailure) {
            const committedRuntimePath =
              service.status.candidate?.canonicalPath ?? targetRuntimePath;
            await persistState({ runtimePath: committedRuntimePath }).catch(() => undefined);
            await operationalLog
              .append("runtime_switch_committed_cleanup_pending", {
                previousRuntimePath,
                runtimePath: committedRuntimePath,
                reasonCode,
              })
              .catch(() => undefined);
          } else {
            await operationalLog
              .append("runtime_switch_rolled_back", {
                previousRuntimePath,
                targetRuntimePath,
                reasonCode,
              })
              .catch(() => undefined);
          }
          throw error;
        } finally {
          persistRuntimeTransitionStatus = false;
        }
      }
      return service.resumeAdmission();
    },
  );
  await persistState();
  const status = await service.start();
  if (initialAdmission === "draining") {
    service.beginDrain();
    await operationalLog.append("release_candidate_admission_draining");
  }
  if (config.tunnel !== undefined) {
    if (status.address === undefined)
      throw new Error("Gateway address is unavailable for tunneling");
    if (config.tunnel.kind === "ngrok") {
      const secretStore = new WindowsDpapiSecretStore({
        directory: join(omniCodexDataDirectory(), "secrets"),
      });
      const ngrokSupervisor = new NgrokTunnelSupervisor({
        ...config.tunnel,
        expectedResource: config.auth.resource ?? config.auth.audience,
        secretStore,
        onSpawned: async (ownership) => {
          await persistState({ tunnelOwnership: ownership });
        },
        onStopped: async () => {
          oracleActionCatalogAutoRefresh?.markEndpointUnavailable();
          await persistState({}, ["tunnel", "tunnelOwnership"]);
        },
        onUnexpectedExit: (error) => {
          oracleActionCatalogAutoRefresh?.markEndpointUnavailable();
          if (stopping || ngrokRecoveryTask !== undefined) return;
          ngrokRecoveryTask = recoverNgrokTunnel(
            ngrokSupervisor,
            status.address as NonNullable<typeof status.address>,
            error,
          ).finally(() => {
            ngrokRecoveryTask = undefined;
          });
        },
      });
      tunnelSupervisor = ngrokSupervisor;
      try {
        await tunnelSupervisor.start(status.address);
      } catch (error) {
        tunnelLastError = toError(error);
        await operationalLog.append("ngrok_tunnel_start_failed", {
          error: tunnelLastError.message,
          gatewayContinues: true,
        });
        if (!(error instanceof NgrokPublicEndpointUnavailableError)) {
          ngrokRecoveryTask = recoverNgrokTunnel(
            ngrokSupervisor,
            status.address,
            tunnelLastError,
          ).finally(() => {
            ngrokRecoveryTask = undefined;
          });
        }
      }
    } else if (config.tunnel.kind !== "direct") {
      const externalTunnelCallbacks = {
        onUnexpectedExit: async (error: Error) => {
          oracleActionCatalogAutoRefresh?.markEndpointUnavailable();
          tunnelLastError = error;
          await persistState({ error: error.message }, ["tunnel"]);
          await operationalLog.append("external_tunnel_unavailable", {
            kind: config.tunnel?.kind ?? "unknown",
            error: error.message,
            gatewayContinues: true,
          });
        },
        onRecovered: async (recovered: ExternalTunnelStatus) => {
          tunnelLastError = undefined;
          await persistState(
            {
              tunnel: {
                kind: recovered.kind,
                publicUrl: recovered.publicUrl,
                pid: recovered.pid,
              },
            },
            ["error"],
          );
          await operationalLog.append("external_tunnel_recovered", {
            kind: recovered.kind,
            pid: recovered.pid,
          });
          markOracleActionCatalogEndpointReady(true);
        },
      };
      const externalTunnelSupervisor =
        config.tunnel.kind === "oracle_ssh"
          ? new ExternalTunnelSupervisor({
              kind: "oracle_ssh",
              executablePath: config.tunnel.executablePath,
              publicUrl: config.tunnel.publicUrl,
              sshHost: config.tunnel.sshHost,
              sshPort: config.tunnel.sshPort,
              sshUser: config.tunnel.sshUser,
              identityFile: config.tunnel.identityFile,
              remotePort: config.tunnel.remotePort,
              reconnectPolicy: { maximumRestarts: 3, delayMs: 1_000 },
              ...externalTunnelCallbacks,
            })
          : new ExternalTunnelSupervisor({
              kind: config.tunnel.kind,
              executablePath: config.tunnel.executablePath,
              publicUrl: config.tunnel.publicUrl,
              ...externalTunnelCallbacks,
            });
      tunnelSupervisor = externalTunnelSupervisor;
      try {
        await externalTunnelSupervisor.start(status.address);
      } catch (error) {
        tunnelLastError = toError(error);
        await operationalLog.append("external_tunnel_start_failed", {
          kind: config.tunnel.kind,
          error: tunnelLastError.message,
          gatewayContinues: true,
        });
      }
    }
  }
  const settledStatus = service.status;
  bootstrapComplete = true;
  lifecycle = daemonLifecycleForGatewayStatus(settledStatus.lifecycle, bootstrapComplete);
  await persistState(
    {
      ...(settledStatus.address === undefined ? {} : { address: settledStatus.address }),
      ...(settledStatus.candidate === undefined
        ? {}
        : { runtimePath: settledStatus.candidate.canonicalPath }),
      ...(tunnelLastError !== undefined
        ? { error: tunnelLastError.message }
        : settledStatus.lastError === undefined
          ? {}
          : { error: settledStatus.lastError }),
      ...(tunnelSupervisor?.status === undefined
        ? {}
        : {
            tunnel: {
              kind: tunnelSupervisor.status.kind,
              publicUrl: tunnelSupervisor.status.publicUrl,
              pid: tunnelSupervisor.status.pid,
            },
          }),
    },
    settledStatus.lifecycle === "ready" && tunnelLastError === undefined ? ["error"] : [],
  );
  await operationalLog.append(
    settledStatus.lifecycle === "ready" ? "daemon_ready" : "daemon_starting",
    {
      runtimePath: settledStatus.candidate?.canonicalPath ?? "unknown",
      port: settledStatus.address?.port ?? 0,
      bridgeRegistryCurrent: settledStatus.bridgeRegistryCurrent === true,
      ...(settledStatus.lastError === undefined ? {} : { error: settledStatus.lastError }),
      tunnel: tunnelSupervisor?.status?.kind ?? "none",
      ...(tunnelLastError === undefined ? {} : { tunnelError: tunnelLastError.message }),
    },
  );
  startGoalContinuationController();
  desktopChatEventSource = new DesktopChatEventSource();
  // The desktop catalog is verified against the currently signed-in account.
  // Oracle bindings can belong to other accounts and are not evidence that a
  // connector is installed in this Desktop Chat.
  const readDesktopChatScope = (signal: AbortSignal) => service.readDesktopChatScope(signal);
  if (!trainingMode)
    desktopApprovalObserver = new DesktopChatApprovalObserver({
      readScope: readDesktopChatScope,
      report: (event) =>
        operationalLog.append(
          event.outcome === "activated"
            ? "desktop_chat_approval_activated"
            : "desktop_chat_approval_failed",
          {
            phase: "desktop_event",
            targetIdSha256: metadataDigest(event.targetId),
            conversationUrlSha256: metadataDigest(event.conversationUrl),
            ...(event.accountSourceId === undefined
              ? {}
              : { accountSourceIdSha256: metadataDigest(event.accountSourceId) }),
            ...(event.pendingMessageId === undefined
              ? {}
              : { pendingMessageIdSha256: metadataDigest(event.pendingMessageId) }),
            ...(event.label === undefined ? {} : { label: event.label }),
            ...(event.strength === undefined ? {} : { strength: event.strength }),
            ...(event.error === undefined ? {} : { error: event.error }),
          },
          { durable: event.outcome === "activated" },
        ),
    });
  desktopGoalObserver = new DesktopChatGoalObserver({
    path: join(omniCodexDataDirectory(), "desktop-goal-readbacks.json"),
    source: desktopChatEventSource,
    store: directGoalStore,
    readCooldown: (account) => service.chatAccountRequests.readCooldown(account),
    readScope: readDesktopChatScope,
    verify: (candidate, signal) => service.verifyDesktopCompletion(candidate, signal),
    readback: (url, anchor, signal) => service.readDesktopCompletion(url, anchor, signal),
    recoverBinding: async (url, accountSourceId, signal) => {
      const endpoint = desktopChatEventSource?.endpoint;
      if (endpoint === undefined) throw new Error("DESKTOP_GOAL_BINDING_READER_NOT_READY");
      const scope = await readDesktopChatScope(signal);
      return service.chatAccountRequests.run(
        accountSourceId,
        (boundary) =>
          readDesktopGoalBindings(
            {
              endpoint,
              conversationUrl: url,
              accountSourceId,
              connectorIds: scope.connectorIds,
              readScope: readDesktopChatScope,
            },
            boundary,
          ),
        signal,
        "report",
      );
    },
    observe: async (observations) => {
      if (goalContinuationController === undefined) throw new Error("GOAL_CONTROLLER_NOT_READY");
      await goalContinuationController.observe(observations);
    },
    onConversationDeleted: (conversationUrl, accountSourceId) =>
      deleteGoalsForConversation(conversationUrl, accountSourceId, "desktop_native_readback"),
    report: (outcome, error) =>
      operationalLog.append(
        outcome === "failed" ? "goal_continuation_failed" : "goal_continuation",
        { phase: "desktop_observation", outcome, ...(error === undefined ? {} : { error }) },
      ),
    onEvent: (event) => {
      const messages = (
        event.notification.payload as {
          update_content?: { messages?: Array<{ metadata?: { request_id?: unknown } }> };
        }
      ).update_content?.messages;
      if (Array.isArray(messages)) {
        const ids = messages.flatMap((message) =>
          typeof message.metadata?.request_id === "string" ? [message.metadata.request_id] : [],
        );
        if (ids.length > 0) {
          const comparison = service.compareDesktopNativeRequestIds(ids);
          void operationalLog
            .append("goal_continuation", {
              phase: "desktop_native_request_identity_comparison",
              source: "desktop_native_pubsub",
              ...comparison,
            })
            .catch((error) =>
              console.error("Desktop request identity comparison logging failed", error),
            );
        }
      }
      if (event.notification.type === "conversation-turn-error") {
        const payload = event.notification.payload as { turn_id?: string; error: unknown };
        void operationalLog
          .append("desktop_conversation_turn_failed", {
            source: "desktop_native_pubsub",
            conversationUrlSha256: metadataDigest(event.conversationUrl),
            ...(payload.turn_id === undefined
              ? {}
              : { turnIdSha256: metadataDigest(payload.turn_id) }),
            error: JSON.stringify(payload.error),
          })
          .catch((error) => console.error("Desktop conversation error logging failed", error));
        if (oracleConversationTurnWasStopped(event.notification)) {
          void readDesktopChatScope(new AbortController().signal)
            .then((scope) =>
              pauseGoalsForConversation(
                event.conversationUrl,
                scope.accountSourceId,
                "desktop_native_pubsub",
              ),
            )
            .catch((error) => console.error("Desktop Goal pause synchronization failed", error));
        }
        return;
      }
      void desktopApprovalObserver?.accept(event);
    },
  });
  await desktopGoalObserver.start();
  for (const transport of oracleTransports.values()) {
    await operationalLog.append("oracle_adapter_ready", {
      cdpEndpoint: transport.binding.cdpEndpoint,
      gatewayContinues: true,
      localBrowserStarted: false,
      approvalWatcherTarget: "oracle_remote_chrome",
    });
    startOracleRemoteCdpTunnelInBackground(transport);
  }
} catch (error) {
  const startupError = toError(error);
  lifecycle = "failed";
  void operationalLog
    .append("daemon_failed", { error: startupError.message })
    .catch(() => undefined);
  void persistState({ error: startupError.message }).catch(() => undefined);
  await shutdown(1, startupError);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", (error, origin) => {
  void operationalLog
    .append("daemon_failed", {
      error: toError(error).message,
      during: `uncaught_exception:${origin}`,
    })
    .catch(() => undefined);
  void shutdown(1, toError(error));
});
process.on("unhandledRejection", (reason) => {
  const error = toError(reason);
  if (isExpectedCancellationRejection(reason)) {
    void operationalLog
      .append("daemon_request_cancellation_observed", {
        error: error.message,
        during: "unhandled_rejection",
      })
      .catch(() => undefined);
    return;
  }
  void operationalLog
    .append("daemon_failed", { error: error.message, during: "unhandled_rejection" })
    .catch(() => undefined);
  void shutdown(1, error);
});

function shutdown(
  exitCode: number,
  terminalError?: Error,
  operatorTimeoutMs?: number,
): Promise<void> {
  if (shutdownTask !== undefined) return shutdownTask;
  stopping = true;
  lifecycle = "stopping";
  // `service.stop()` establishes its generation fence and closes admission
  // synchronously, before logging, persistence, tunnels, or auxiliary browser
  // cleanup can yield. Accepted work then drains inside the bounded phase.
  // Omission means lossless drain. Only an explicit operator deadline may
  // cancel an admitted native call during a stop or deployment.
  const shutdownTimeoutMs = operatorTimeoutMs;
  const ownedRuntimeStop = service.stop(shutdownTimeoutMs);
  const ownedRuntimeStopAndCleanup = ownedRuntimeStop.then(() =>
    removeOmniCodexRuntimeWriteEnvironment({
      dataDirectory: omniCodexDataDirectory(),
      instanceId: runtimeInstanceId,
    }),
  );
  for (const transport of oracleTransports.values()) {
    transport.startupAbort?.abort(new Error("OmniCodex daemon is stopping"));
  }
  const operation = performShutdown(
    exitCode,
    ownedRuntimeStopAndCleanup,
    terminalError,
    shutdownTimeoutMs,
  );
  shutdownTask = operation;
  return operation;
}

async function performShutdown(
  requestedExitCode: number,
  ownedRuntimeStopAndCleanup: Promise<unknown>,
  terminalError?: Error,
  operatorTimeoutMs?: number,
): Promise<void> {
  let finalExitCode = 1;
  const pendingShutdownComponents = new Set<string>();
  const trackShutdownComponent = (
    name: string,
    operation: () => Promise<unknown> | unknown,
  ): Promise<unknown> => {
    pendingShutdownComponents.add(name);
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        pendingShutdownComponents.delete(name);
      });
  };
  try {
    const phaseResults = await runBoundedShutdownSequence(
      [
        {
          name: "admission-and-owned-runtime-drain",
          ...(operatorTimeoutMs === undefined ? {} : { budgetMs: operatorTimeoutMs }),
          run: () => [
            trackShutdownComponent(
              "gateway-and-runtime-write-environment",
              () => ownedRuntimeStopAndCleanup,
            ),
            trackShutdownComponent("goal-continuation-controller", () =>
              goalContinuationController?.stop(),
            ),
            trackShutdownComponent("desktop-approval-observer", () =>
              desktopApprovalObserver?.stop(),
            ),
            trackShutdownComponent("desktop-goal-observer", () => desktopGoalObserver?.stop()),
            trackShutdownComponent("shutdown-operational-log", () =>
              operationalLog.append("daemon_stopping"),
            ),
            trackShutdownComponent("shutdown-state-persistence", () => persistState()),
          ],
        },
        {
          name: "tunnel-cleanup",
          run: () => [
            Promise.resolve().then(() => stopOracleActionCatalogAutoRefresh()),
            ...oracleBindingRuntimes.map((runtime) =>
              Promise.resolve().then(() => runtime.watcher?.stop()),
            ),
            ...[...oracleTransports.values()].flatMap((transport) => [
              Promise.resolve().then(() => stopOracleApprovalOwnershipGuard(transport)),
              Promise.resolve().then(() => transport.supervisor?.stop()),
            ]),
            Promise.resolve().then(() => tunnelSupervisor?.stop()),
          ],
        },
      ],
      {
        onPhaseStart: (name) => {
          void operationalLog
            .append("daemon_stopping", { phase: name, phaseState: "starting" })
            .catch(() => undefined);
        },
        onPhaseComplete: (result) => {
          void operationalLog
            .append("daemon_stopping", {
              phase: result.name,
              phaseState: "completed",
              timedOut: result.timedOut,
              errorCount: result.errors.length,
              errorSummariesJson: JSON.stringify(result.errors.map(shutdownErrorSummary)),
              pendingComponentsJson: JSON.stringify([...pendingShutdownComponents]),
            })
            .catch(() => undefined);
        },
      },
    );
    const cleanupErrors = shutdownSequenceErrors(phaseResults);
    const errors = [...(terminalError === undefined ? [] : [terminalError]), ...cleanupErrors];
    const failureMessage =
      errors.length === 0
        ? undefined
        : cleanupErrors.length === 0 && terminalError !== undefined
          ? terminalError.message
          : shutdownErrorSummary(
              new AggregateError(errors, "OmniCodex daemon shutdown was not clean"),
            );
    // The durable state schema intentionally has no `stopped`: while the PID is
    // alive it remains `stopping`; after exit, PID liveness is the authoritative
    // terminal readback. Cleanup failure is persisted explicitly as `failed`.
    lifecycle = failureMessage === undefined ? "stopping" : "failed";

    const finalResults = await runBoundedShutdownSequence([
      {
        name: "control-and-terminal-state",
        run: () => [
          Promise.resolve().then(() => closeControlServer(controlServer)),
          Promise.resolve().then(() =>
            failureMessage === undefined
              ? operationalLog.append("daemon_stopped")
              : operationalLog.append("daemon_failed", {
                  error: failureMessage,
                  during: "bounded_shutdown",
                }),
          ),
          Promise.resolve().then(() =>
            failureMessage === undefined
              ? persistState({}, ["error"])
              : persistState({ error: failureMessage }),
          ),
        ],
      },
    ]);
    errors.push(...shutdownSequenceErrors(finalResults));
    finalExitCode = errors.length === 0 ? requestedExitCode : 1;
  } catch (error) {
    const shutdownError = toError(error);
    lifecycle = "failed";
    void closeControlServer(controlServer).catch(() => undefined);
    void operationalLog
      .append("daemon_failed", { error: shutdownError.message, during: "shutdown_barrier" })
      .catch(() => undefined);
    void persistState({ error: shutdownError.message }).catch(() => undefined);
  } finally {
    directScheduleIntegrityKey.fill(0);
    durableMcpEventsIntegrityKey.fill(0);
    process.exitCode = finalExitCode;
    setImmediate(() => process.exit(finalExitCode));
  }
}

async function persistState(
  fields: Partial<
    Pick<
      OmniCodexDaemonState,
      "address" | "runtimePath" | "releasePath" | "tunnel" | "tunnelOwnership" | "error"
    >
  > = {},
  removeFields: readonly (keyof typeof persistedFields)[] = [],
): Promise<void> {
  const operation = persistStateTail.then(async () => {
    const next = { ...persistedFields, ...fields };
    for (const field of removeFields) Reflect.deleteProperty(next, field);
    persistedFields = next;
    await writeOmniCodexDaemonState({
      schemaVersion: 1,
      lifecycle,
      pid: process.pid,
      instanceNonce,
      startedAtUnixMs,
      updatedAtUnixMs: Date.now(),
      controlPipe,
      controlToken,
      releasePath,
      releaseFingerprint,
      ...persistedFields,
    });
  });
  persistStateTail = operation.catch(() => undefined);
  return operation;
}

/**
 * The Windows side owns only a hidden SSH loopback forward and one CDP watcher
 * for the isolated Oracle Chrome. It never launches, reads, or controls the
 * user's local Chrome profile. This recovery loop is deliberately outside
 * gateway readiness.
 */
function startOracleRemoteCdpTunnelInBackground(transport: OracleTransportRuntime): void {
  const remote = transport.binding.remoteCdpTunnel;
  if (
    !transport.binding.enabled ||
    stopping ||
    transport.startupTask !== undefined ||
    transport.supervisor !== undefined
  ) {
    return;
  }
  const abort = new AbortController();
  transport.startupAbort = abort;
  const task = initializeOracleRemoteCdpTunnel(transport, remote, abort.signal)
    .catch((error) =>
      operationalLog
        .append("oracle_remote_cdp_tunnel_failed", {
          error: toError(error).message,
          cdpEndpoint: transport.binding.cdpEndpoint,
          phase: "background_start_internal_error",
          gatewayContinues: true,
        })
        .catch(() => undefined),
    )
    .then(() => undefined)
    .finally(() => {
      if (transport.startupTask === task) delete transport.startupTask;
      if (transport.startupAbort === abort) delete transport.startupAbort;
    });
  transport.startupTask = task;
}

async function initializeOracleRemoteCdpTunnel(
  transport: OracleTransportRuntime,
  remote: OmniCodexOracleClientBinding["remoteCdpTunnel"],
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; !stopping && !signal.aborted; attempt += 1) {
    let supervisor: OracleRemoteCdpTunnelSupervisor | undefined;
    try {
      if (remote === undefined) {
        await startOracleApprovalAutomation(transport);
        markOracleActionCatalogEndpointReady(false);
        return;
      }
      supervisor = new OracleRemoteCdpTunnelSupervisor({
        cdpEndpoint: transport.binding.cdpEndpoint,
        remote,
        onUnexpectedExit: async (error) => {
          await stopOracleApprovalOwnershipGuard(transport);
          if (transport.supervisor === supervisor) {
            delete transport.supervisor;
          }
          if (!oracleActionCatalogRefreshTransportsReady()) {
            oracleActionCatalogAutoRefresh?.markEndpointUnavailable();
          }
          await operationalLog
            .append("oracle_remote_cdp_tunnel_failed", {
              error: error.message,
              cdpEndpoint: transport.binding.cdpEndpoint,
              phase: "unexpected_exit",
              gatewayContinues: true,
            })
            .catch(() => undefined);
          startOracleRemoteCdpTunnelRecovery(error, transport);
        },
      });
      transport.supervisor = supervisor;
      const status = await supervisor.start();
      if (stopping || signal.aborted) {
        await supervisor.stop().catch(() => undefined);
        if (transport.supervisor === supervisor) delete transport.supervisor;
        return;
      }
      await operationalLog.append("oracle_remote_cdp_tunnel_ready", {
        attempt,
        ownership: status.ownership,
        pid: status.pid ?? null,
        cdpEndpoint: status.cdpEndpoint,
        remoteHost: status.sshHost,
        remoteCdpPort: status.remoteCdpPort,
        gatewayContinues: true,
      });
      await startOracleApprovalAutomation(transport);
      markOracleActionCatalogEndpointReady(true);
      return;
    } catch (error) {
      await supervisor?.stop().catch(() => undefined);
      if (transport.supervisor === supervisor) delete transport.supervisor;
      if (!oracleActionCatalogRefreshTransportsReady()) {
        oracleActionCatalogAutoRefresh?.markEndpointUnavailable();
      }
      if (stopping || signal.aborted) return;
      const retryDelayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
      await operationalLog
        .append("oracle_remote_cdp_tunnel_failed", {
          attempt,
          cdpEndpoint: transport.binding.cdpEndpoint,
          error: toError(error).message,
          phase: "background_start_attempt",
          retryDelayMs,
          gatewayContinues: true,
        })
        .catch(() => undefined);
      await delay(retryDelayMs, signal).catch(() => undefined);
    }
  }
}

function markOracleActionCatalogEndpointReady(retryCurrentRevision: boolean): void {
  const coordinator = oracleActionCatalogAutoRefresh;
  if (coordinator === undefined || stopping) return;
  if (!oracleActionCatalogRefreshTransportsReady()) {
    coordinator.markEndpointUnavailable();
    return;
  }
  const operation = coordinator
    .markEndpointReady(retryCurrentRevision)
    .catch((error) =>
      operationalLog.append("oracle_action_catalog_sync_failed", {
        ...oracleCatalogRefreshErrorDetails(error),
        trigger: "endpoint_ready",
        gatewayContinues: true,
      }),
    )
    .then(() => undefined)
    .finally(() => {
      if (oracleActionCatalogScheduleTask === operation) {
        oracleActionCatalogScheduleTask = undefined;
      }
    });
  const scheduled = oracleActionCatalogScheduleTask;
  if (scheduled === undefined) {
    oracleActionCatalogScheduleTask = operation;
    return;
  }
  const combined = Promise.allSettled([scheduled, operation])
    .then(() => undefined)
    .finally(() => {
      if (oracleActionCatalogScheduleTask === combined) {
        oracleActionCatalogScheduleTask = undefined;
      }
    });
  oracleActionCatalogScheduleTask = combined;
}

function oracleActionCatalogRefreshTransportsReady(): boolean {
  const runningPublicTunnel = tunnelSupervisor?.status;
  return [...oracleTransports.values()].some((transport) =>
    oracleActionCatalogTransportsReady({
      enabled: transport.binding.enabled,
      publicTunnel: config.tunnel,
      runningPublicTunnel:
        runningPublicTunnel === undefined
          ? undefined
          : {
              kind: runningPublicTunnel.kind,
              publicUrl: runningPublicTunnel.publicUrl,
            },
      remoteCdpConfigured: transport.binding.remoteCdpTunnel !== undefined,
      remoteCdpReady: transport.supervisor?.status !== undefined,
      directCdpReady:
        transport.guard !== undefined &&
        oracleBindingRuntimes.some(
          (runtime) => runtime.transport === transport && runtime.watcher !== undefined,
        ),
    }),
  );
}

function scheduleOracleActionCatalogRefresh(
  reason: "catalog_observed" | "runtime_ready",
  observedRevision?: string,
): void {
  const coordinator = oracleActionCatalogAutoRefresh;
  if (coordinator === undefined || oracleActionCatalogScheduleTask !== undefined || stopping)
    return;
  const operation = coordinator
    .synchronize(reason, observedRevision)
    .catch((error) =>
      operationalLog.append("oracle_action_catalog_sync_failed", {
        ...oracleCatalogRefreshErrorDetails(error),
        trigger: reason,
        gatewayContinues: true,
      }),
    )
    .then(() => undefined)
    .finally(() => {
      if (oracleActionCatalogScheduleTask === operation) {
        oracleActionCatalogScheduleTask = undefined;
      }
    });
  oracleActionCatalogScheduleTask = operation;
}

async function runOracleActionCatalogRefresh(
  clientBinding: string,
  catalogRevision: string,
): Promise<void> {
  if (stopping) return;
  const current = selectOracleClientConfig(await loadOmniCodexConfig(), clientBinding);
  const oracle = current.oracle;
  if (oracle?.enabled !== true || oracle.remoteCdpTunnel === undefined) {
    throw new Error("ORACLE_ACTION_REFRESH_REQUIRES_VERIFIED_CONNECTION");
  }
  if (stopping) return;
  const controller = new AbortController();
  oracleActionCatalogRefreshAbort = controller;
  const operationDetails = {
    clientBinding,
    catalogRevision,
    correlationId: oracle.runId,
    trigger: "explicit_refresh",
    gatewayContinues: true,
    localBrowserStarted: false,
    approvalWatcherTarget: "oracle_remote_chrome",
  };
  try {
    const stableCatalogBaseline = await readStableOracleActionCatalogBaseline({
      read: () => service.readFullCatalogSnapshot(),
      signal: controller.signal,
    });
    // Reuse the same model-free control-plane operation as the CLI. Keeping
    // this in-process preserves HTTP status, Retry-After, and cancellation;
    // there is no settings renderer or child stderr serialization boundary.
    await new OracleAdapterService({ clientBinding }).refreshActionsControlPlane(
      new ChatGptActionCatalogControlClient({ cdpEndpoint: oracle.cdpEndpoint }),
      { sessionId: oracle.runId, correlationId: oracle.runId },
      {
        signal: controller.signal,
        expectedDaemonPid: process.pid,
        readLocalCatalogBaseline: async () => ({
          daemonPid: process.pid,
          ...stableCatalogBaseline,
        }),
      },
    );
    // Record the actual refresh once, not once per joined synchronization
    // caller. The lightweight runtime counters inherit this execution boundary.
    await operationalLog.append("oracle_action_catalog_refreshed", operationDetails);
  } catch (error) {
    await operationalLog
      .append("oracle_action_catalog_refresh_failed", {
        ...operationDetails,
        ...oracleCatalogRefreshErrorDetails(error),
      })
      .catch(() => undefined);
    if (oracleActionCatalogCdpRecoveryRequired(error)) {
      const transport = oracleBindingRuntimes.find(
        (runtime) => runtime.key === clientBinding,
      )?.transport;
      if (transport?.supervisor?.status?.ownership === "owned") {
        startOracleRemoteCdpTunnelRecovery(toError(error), transport);
      }
    }
    throw error;
  } finally {
    if (oracleActionCatalogRefreshAbort === controller) oracleActionCatalogRefreshAbort = undefined;
  }
}

function oracleActionCatalogCdpRecoveryRequired(error: unknown): boolean {
  const pending = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof Error) {
      if (
        current.message === "CDP_BROWSER_VERSION_UNAVAILABLE" ||
        current.message === "CDP_BROWSER_COMMAND_LIVENESS_TIMEOUT" ||
        current.message === "CDP_BROWSER_OPEN_FAILED" ||
        current.message === "CDP_BROWSER_SESSION_ERROR"
      ) {
        return true;
      }
      pending.push(current.cause);
      if (current instanceof AggregateError) pending.push(...current.errors);
    }
  }
  return false;
}

async function stopOracleActionCatalogAutoRefresh(): Promise<void> {
  oracleActionCatalogRefreshAbort?.abort(new Error("Oracle catalog refresh stopped"));
  await oracleActionCatalogAutoRefresh?.stop();
}

function oracleCatalogRefreshErrorDetails(error: unknown) {
  return {
    error: toError(error).message,
    errorDetails: JSON.stringify(structuredErrorDetails(error)),
    ...(error instanceof ChatGptControlPlaneHttpError
      ? {
          status: error.status,
          operation: error.operation,
          retryAtUnixMs: error.retryAtUnixMs ?? null,
          responseHeaders: JSON.stringify(error.responseHeaders),
        }
      : {}),
  };
}

async function startOracleApprovalAutomation(transport: OracleTransportRuntime): Promise<void> {
  if (trainingMode) return;
  await startOracleApprovalOwnershipGuard(transport);
  for (const runtime of oracleBindingRuntimes) {
    if (runtime.transport === transport) startOracleApprovalWatcher(runtime);
  }
}

async function startOracleApprovalOwnershipGuard(transport: OracleTransportRuntime): Promise<void> {
  if (transport.guardStartupTask !== undefined) {
    return transport.guardStartupTask;
  }
  if (transport.guard !== undefined) return;
  const task = (async () => {
    const oracle = transport.binding;
    if (oracle?.enabled !== true || stopping) return;
    const guard = new OracleApprovalOwnershipGuard({
      endpoint: oracle.cdpEndpoint,
      timeoutMs: ORACLE_APPROVAL_CDP_COMMAND_TIMEOUT_MS,
      onUnhealthy: async (error) => {
        await operationalLog
          .append("oracle_approval_ownership_guard_unhealthy", {
            error: error.message,
            cdpEndpoint: oracle.cdpEndpoint,
            approvalWatcherTarget: "oracle_remote_chrome",
            localBrowserStarted: false,
          })
          .catch(() => undefined);
        startOracleRemoteCdpTunnelRecovery(error, transport);
      },
    });
    transport.guard = guard;
    try {
      await guard.start();
      await operationalLog.append("oracle_approval_ownership_guard_ready", {
        cdpEndpoint: oracle.cdpEndpoint,
        approvalWatcherTarget: "oracle_remote_chrome",
        localBrowserStarted: false,
      });
    } catch (error) {
      if (transport.guard === guard) delete transport.guard;
      await guard.stop().catch(() => undefined);
      throw error;
    }
  })().finally(() => {
    if (transport.guardStartupTask === task) {
      delete transport.guardStartupTask;
    }
  });
  transport.guardStartupTask = task;
  return task;
}

async function stopOracleApprovalOwnershipGuard(transport: OracleTransportRuntime): Promise<void> {
  await transport.guardStartupTask?.catch(() => undefined);
  const guard = transport.guard;
  if (transport.guard === guard) delete transport.guard;
  await guard?.stop().catch(() => undefined);
}

function startGoalContinuationController(): void {
  if (goalContinuationController !== undefined || stopping) return;
  goalContinuationController = new GoalContinuationController(
    directGoalStore,
    async (target, signal) => {
      if (target.draft.transport === "desktop") return service.continueDesktopGoal(target, signal);
      const client = selectOracleGoalClient(
        target,
        oracleBindingRuntimes.flatMap((runtime) =>
          runtime.client === undefined
            ? []
            : [
                {
                  client: runtime.client,
                  connectorId: runtime.binding.connectorId,
                  conversationUrls: runtime.conversationUrls,
                  primary: runtime.primary,
                },
              ],
        ),
      );
      return (
        client?.continueGoal(target, signal) ?? Promise.resolve({ outcome: "runtime_not_ready" })
      );
    },
    async (goalId, outcome, error) => {
      await operationalLog.append("goal_continuation", {
        goalId,
        outcome,
        ...(error === undefined ? {} : { error }),
      });
    },
    async (target) => {
      if (target.draft.transport === "desktop") return false;
      const conversationId = new URL(target.conversationUrl).pathname.slice(3);
      const foreground = foregroundMcpActivity.snapshot({
        chatGptConversationIdSha256: metadataDigest(conversationId),
        workSessionBindingSha256s: target.workSessionBindingSha256s,
      });
      if (foreground.active) return true;
      const nativeTaskStatus = await service
        .readChatGptConversationStatus(conversationId)
        .catch(() => undefined);
      const observedTurnActivities = oracleBindingRuntimes.flatMap((runtime) => {
        const activity = runtime.conversationActivity.get(target.conversationUrl);
        return activity === undefined ? [] : [activity];
      });
      const observedTurnActivity = observedTurnActivities.includes("active")
        ? "active"
        : observedTurnActivities.includes("idle")
          ? "idle"
          : undefined;
      return (
        decideOracleInteractiveActivity(nativeTaskStatus, observedTurnActivity, true) === "active"
      );
    },
  );
  goalContinuationController.start();
}

async function pauseGoalsForConversation(
  conversationUrl: string,
  accountSourceId: string,
  source: "desktop_native_pubsub" | "oracle_native_pubsub",
  clientBinding?: string,
): Promise<void> {
  const paused = await directGoalStore.pauseConversation({ conversationUrl, accountSourceId });
  if (paused.length > 0) goalContinuationController?.wake();
  await operationalLog.append("goal_continuation", {
    phase: "conversation_stopped_goal_pause",
    source,
    conversationUrlSha256: metadataDigest(conversationUrl),
    accountSourceIdSha256: metadataDigest(accountSourceId),
    pausedGoalCount: paused.length,
    ...(clientBinding === undefined ? {} : { clientBinding }),
  });
}

async function deleteGoalsForConversation(
  conversationUrl: string,
  accountSourceId: string,
  source: "desktop_native_readback" | "oracle_server_readback",
  clientBinding?: string,
): Promise<void> {
  const deleted = await directGoalStore.deleteConversation({ conversationUrl, accountSourceId });
  await operationalLog.append("goal_continuation", {
    phase: "conversation_deleted_goal_cleanup",
    source,
    conversationUrlSha256: metadataDigest(conversationUrl),
    accountSourceIdSha256: metadataDigest(accountSourceId),
    deletedGoalCount: deleted.length,
    ...(clientBinding === undefined ? {} : { clientBinding }),
  });
}

function startOracleApprovalWatcher(runtime: OracleBindingRuntime): void {
  const oracle = runtime.binding;
  if (
    oracle?.enabled !== true ||
    stopping ||
    runtime.watcher !== undefined ||
    oracleActiveRunRegistry === undefined
  ) {
    return;
  }
  const pendingStoppedConversationUrls = new Set<string>();
  const pauseStoppedConversation = (url: string, accountSourceId: string): void => {
    pendingStoppedConversationUrls.delete(url);
    void pauseGoalsForConversation(url, accountSourceId, "oracle_native_pubsub", runtime.key).catch(
      (error) => console.error("Oracle Goal pause synchronization failed", error),
    );
  };
  const eventSource = new OracleConversationEventSource({
    cdpEndpoint: oracle.cdpEndpoint,
    onRequestIdentity: (url, ids) => {
      const comparison = service.compareDesktopNativeRequestIds(ids);
      void operationalLog
        .append("goal_continuation", {
          phase: "oracle_native_request_identity_comparison",
          clientBinding: runtime.key,
          source: "oracle_native_pubsub",
          conversationUrlSha256: metadataDigest(url),
          ...comparison,
        })
        .catch((error) =>
          console.error("Oracle request identity comparison logging failed", error),
        );
    },
    onTurnError: (url, notification) => {
      const payload = notification.payload as { turn_id?: string; error: unknown };
      void operationalLog
        .append("oracle_conversation_turn_failed", {
          clientBinding: runtime.key,
          source: "oracle_native_pubsub",
          conversationUrlSha256: metadataDigest(url),
          ...(payload.turn_id === undefined
            ? {}
            : { turnIdSha256: metadataDigest(payload.turn_id) }),
          error: JSON.stringify(payload.error),
        })
        .catch((error) => console.error("Oracle conversation error logging failed", error));
      if (oracleConversationTurnWasStopped(notification)) {
        const accountSourceId = runtime.client?.accountSourceId;
        if (accountSourceId === undefined) pendingStoppedConversationUrls.add(url);
        else pauseStoppedConversation(url, accountSourceId);
      }
    },
  });
  runtime.eventSource = eventSource;
  const client = new OracleChatGptServerApprovalClient({
    onAccountSourceVerified: (accountSourceId) => {
      scheduleOracleActionCatalogRefresh("runtime_ready");
      for (const url of [...pendingStoppedConversationUrls])
        pauseStoppedConversation(url, accountSourceId);
    },
    accountCooldown: {
      read: (account) => service.chatAccountRequests.readCooldown(account),
      observe: (account, snapshot) =>
        service.chatAccountRequests.observeCooldown(account, snapshot),
      reserveBackgroundRequest: (account, minimumIntervalMs) =>
        service.chatAccountRequests.reserveBackgroundRequest(account, minimumIntervalMs),
      reserveRecoveryRequest: (account, minimumIntervalMs) =>
        service.chatAccountRequests.reserveRecoveryRequest(account, minimumIntervalMs),
      reserveForegroundRequest: (account, minimumIntervalMs, signal) =>
        service.chatAccountRequests.reserveForegroundRequest(account, minimumIntervalMs, signal),
      reserveGoalContinuationRequest: (account, minimumIntervalMs, signal) =>
        service.chatAccountRequests.reserveForegroundRequest(account, minimumIntervalMs, signal),
    },
    connectorId: oracle.connectorId,
    connectorName: oracle.connectorName,
    cdpEndpoint: oracle.cdpEndpoint,
    conversationEvents: eventSource,
    recoverGoalConversations: (account) =>
      directGoalStore.continuationConversationUrls(account, oracle.connectorId),
    captureGoalCheckpoints: (account) =>
      directGoalStore.continuationCheckpoints(account, oracle.connectorId),
    hasUnboundGoal: () => directGoalStore.hasUnboundContinuation({ activeOnly: true }),
    onConversationDeleted: async (conversationUrl, accountSourceId) => {
      runtime.conversationUrls.delete(conversationUrl);
      runtime.conversationActivity.delete(conversationUrl);
      await deleteGoalsForConversation(
        conversationUrl,
        accountSourceId,
        "oracle_server_readback",
        runtime.key,
      );
    },
    onGoalConversations: async (observations) => {
      try {
        for (const observation of observations) {
          runtime.conversationUrls.add(observation.conversationUrl);
          if (observation.current !== undefined)
            runtime.conversationActivity.set(
              observation.conversationUrl,
              observation.current.authorRole === "assistant" && observation.current.endTurn === true
                ? "idle"
                : "active",
            );
        }
        const verifiedObservations = await Promise.all(
          observations.map(async (observation) => {
            const goalId = observation.requestedGoalId ?? observation.checkpoint?.goalId;
            const recoverableIdleHead =
              observation.current?.status === "finished_successfully" &&
              (observation.current.authorRole === "user" ||
                (observation.source?.kind === "web" &&
                  observation.current.authorRole === "assistant" &&
                  observation.current.endTurn !== true));
            if (goalId === undefined || !recoverableIdleHead) return observation;
            const conversationId = new URL(observation.conversationUrl).pathname.slice(3);
            const nativeTaskStatus = await service
              .readChatGptConversationStatus(conversationId)
              .catch(() => undefined);
            const foreground = foregroundMcpActivity.snapshot({
              chatGptConversationIdSha256: metadataDigest(conversationId),
            });
            const foregroundStage = foreground.stage;
            const effectiveNativeTaskStatus =
              foregroundStage === "idle" ? nativeTaskStatus : "active";
            await operationalLog.append("goal_continuation", {
              phase: "oracle_observation_status",
              goalId,
              nativeTaskStatus: effectiveNativeTaskStatus ?? "unavailable",
              foregroundStage,
              activeMcpCalls: foreground.activeCallCount,
              ...(foreground.quietUntilUnixMs === undefined
                ? {}
                : { foregroundQuietUntilUnixMs: foreground.quietUntilUnixMs }),
              currentRole: observation.current?.authorRole ?? "missing",
              currentStatus: observation.current?.status ?? "missing",
              currentChannel: observation.current?.channel ?? "missing",
              currentEndTurn: observation.current?.endTurn ?? false,
            });
            return effectiveNativeTaskStatus === undefined
              ? observation
              : { ...observation, nativeTaskStatus: effectiveNativeTaskStatus };
          }),
        );
        await goalContinuationController?.observe(
          verifiedObservations.map((observation) => ({
            ...observation,
            goals: observation.goals.map((goal) => ({ ...goal, connectorId: oracle.connectorId })),
          })),
        );
      } catch (error) {
        await operationalLog.append("goal_continuation_failed", {
          error: String(error),
          phase: "host_observation",
        });
        // Keep the exact observation queued when the durable consumer requires
        // another causal readback; logging alone must not acknowledge delivery.
        throw error;
      }
    },
    onConversationEvent: (url, approvals) => {
      runtime.conversationUrls.add(url);
      void operationalLog
        .append("oracle_conversation_event_observed", {
          conversationUrlSha256: metadataDigest(url),
          source: "oracle_native_pubsub",
          clientBinding: runtime.key,
          purpose: approvals.length > 0 ? "pending_approval" : "active_goal",
          approvalTargets: JSON.stringify(
            approvals.map((approval) => ({
              pendingMessageIdSha256: metadataDigest(approval.pendingMessageId),
              targetMessageIdSha256s: approval.targetMessageIds.map(metadataDigest),
            })),
          ),
        })
        .catch(() => undefined);
    },
    onConversationActivity: (url, state) => {
      runtime.conversationUrls.add(url);
      runtime.conversationActivity.set(url, state);
    },
    // Exact request targets, real user PubSub events, and durable receipts;
    // never expand opaque request identities through account index polling.
  });
  runtime.client = client;
  startGoalContinuationController();
  goalContinuationController?.wake();
  const watcher = new OracleApprovalPopupWatcher({
    connectorId: oracle.connectorId,
    connectorName: oracle.connectorName,
    resource: oracle.resource,
    surface: oracle.surface,
    cdpEndpoint: oracle.cdpEndpoint,
    pollIntervalMs: 1_000,
    serverApprovalClient: client,
    synchronizeApprovalReceipt: async (receipt, signal) => {
      const result = await service.synchronizeApprovedChromeConversation(
        {
          conversationUrl: receipt.conversationUrl,
          pendingMessageId: receipt.pendingMessageId,
          ...(receipt.userMessageId === undefined ? {} : { userMessageId: receipt.userMessageId }),
        },
        signal,
      );
      const summary = chromeFileApprovalResultSummary(result);
      const { rateLimit, ...logSummary } = summary;
      const complete = chromeApprovalReceiptSynchronized(summary.outcome);
      await operationalLog.append(
        complete ? "oracle_approval_chrome_synchronized" : "oracle_approval_chrome_sync_failed",
        {
          conversationIdSha256: metadataDigest(receipt.conversationId),
          clientMessageIdSha256: metadataDigest(receipt.clientMessageId),
          ...logSummary,
          ...(typeof rateLimit?.retryAtUnixMs === "number"
            ? { retryAtUnixMs: rateLimit.retryAtUnixMs }
            : {}),
        },
      );
      return complete;
    },
    ensureConversationTarget: async (conversationUrl, signal) => {
      const mirror = runtime.mirror;
      if (mirror === undefined) throw new Error("ORACLE_APPROVAL_MIRROR_NOT_READY");
      await mirror.prepareForProtectedResult(conversationUrl, signal);
    },
    resolveActiveRun: async (target) =>
      runtime.mirror.activeRunForTarget(target) ??
      (await oracleActiveRunRegistry.activeRunForTarget(target)),
    recoverUnresponsiveOwnedMirror: async (target, signal) => {
      const mirror = runtime.mirror;
      if (mirror === undefined) throw new Error("ORACLE_APPROVAL_MIRROR_NOT_READY");
      await mirror.recoverUnresponsiveOwnedTarget(target, signal);
    },
    releaseStableIdleOwnedMirror: async (target, signal) => {
      const mirror = runtime.mirror;
      if (mirror === undefined) throw new Error("ORACLE_APPROVAL_MIRROR_NOT_READY");
      await mirror.releaseStableIdleOwnedTarget(target, signal);
    },
    onEvent: (event) => logOracleApprovalEvent(event, runtime),
  });
  runtime.watcher = watcher;
  watcher.start();
}

async function logOracleApprovalEvent(
  event: OracleApprovalPopupEvent,
  runtime: OracleBindingRuntime,
): Promise<void> {
  const details = {
    clientBinding: runtime.key,
    approvalWatcherTarget: "oracle_remote_chrome",
    localBrowserStarted: false,
    ...(event.targetId === undefined ? {} : { targetIdSha256: metadataDigest(event.targetId) }),
    ...(event.oracleRunId === undefined ? {} : { oracleRunId: event.oracleRunId }),
    ...(event.label === undefined ? {} : { label: event.label }),
    ...(event.strength === undefined ? {} : { strength: event.strength }),
    ...(event.error === undefined ? {} : { error: event.error }),
  };
  switch (event.type) {
    case "server_requests_observed":
      if (event.requestStats !== undefined) {
        const stats = event.requestStats;
        await operationalLog.append("oracle_approval_requests_observed", {
          ...details,
          ...stats,
          conversationIds: JSON.stringify(stats.conversationIds.map(metadataDigest)),
          requests: JSON.stringify(
            stats.requests.map(({ conversationId, path, ...request }) => ({
              ...request,
              path:
                conversationId === undefined
                  ? path
                  : path.replace(encodeURIComponent(conversationId), ":conversationId"),
              ...(conversationId === undefined
                ? {}
                : { conversationIdSha256: metadataDigest(conversationId) }),
            })),
          ),
        });
      }
      return;
    case "server_response_error":
      await operationalLog.append("oracle_approval_server_response_error", {
        ...details,
        ...(event.serverError === undefined
          ? {}
          : {
              conversationIdSha256: metadataDigest(event.serverError.conversationId),
              error: event.serverError.error,
              ...(event.serverError.submissionState === undefined
                ? {}
                : { submissionState: event.serverError.submissionState }),
              ...(event.serverError.status === undefined
                ? {}
                : { status: event.serverError.status }),
              ...(event.serverError.operation === undefined
                ? {}
                : { operation: event.serverError.operation }),
              ...(event.serverError.observedAtUnixMs === undefined
                ? {}
                : { observedAtUnixMs: event.serverError.observedAtUnixMs }),
              ...Object.fromEntries(
                Object.entries(event.serverError.responseHeaders ?? {}).map(([name, value]) => [
                  `responseHeader:${name}`,
                  value,
                ]),
              ),
            }),
      });
      return;
    case "rate_limited":
      await operationalLog.append("oracle_approval_rate_limited", {
        ...details,
        status: event.rateLimit?.status ?? 429,
        operation: event.rateLimit?.operation ?? "unknown",
        retryAtUnixMs: event.rateLimit?.retryAtUnixMs ?? 0,
        ...(event.rateLimit?.observedAtUnixMs === undefined
          ? {}
          : { observedAtUnixMs: event.rateLimit.observedAtUnixMs }),
        ...(event.rateLimit?.serverRetryAtUnixMs === undefined
          ? {}
          : { serverRetryAtUnixMs: event.rateLimit.serverRetryAtUnixMs }),
        ...(event.rateLimit?.localBackoffMs === undefined
          ? {}
          : { localBackoffMs: event.rateLimit.localBackoffMs }),
        ...(event.rateLimit?.statusEvidence === undefined
          ? {}
          : { statusEvidence: event.rateLimit.statusEvidence }),
        ...(event.rateLimit?.backoffSource === undefined
          ? {}
          : { backoffSource: event.rateLimit.backoffSource }),
        ...Object.fromEntries(
          Object.entries(event.rateLimit?.responseHeaders ?? {}).map(([name, value]) => [
            `responseHeader:${name}`,
            value,
          ]),
        ),
      });
      return;
    case "watcher_started":
      await operationalLog.append("oracle_approval_watcher_started", details);
      return;
    case "activated":
      await operationalLog.append(
        "oracle_approval_activated",
        {
          ...details,
          ...(event.receipt === undefined
            ? {}
            : {
                conversationIdSha256: metadataDigest(event.receipt.conversationId),
                conversationUrlSha256: metadataDigest(event.receipt.conversationUrl),
                pendingMessageIdSha256: metadataDigest(event.receipt.pendingMessageId),
                clientMessageIdSha256: metadataDigest(event.receipt.clientMessageId),
                targetMessageIdSha256: metadataDigest(event.receipt.targetMessageId),
                action: event.receipt.action,
                rememberAnswer: event.receipt.rememberAnswer,
                ...(event.receipt.responseStatus === undefined
                  ? {}
                  : { responseStatus: event.receipt.responseStatus }),
              }),
        },
        { durable: event.receipt !== undefined },
      );
      return;
    case "receipt_sync_failed":
      await operationalLog.append("oracle_approval_chrome_sync_failed", {
        ...details,
        ...(event.receipt === undefined
          ? {}
          : {
              conversationIdSha256: metadataDigest(event.receipt.conversationId),
              clientMessageIdSha256: metadataDigest(event.receipt.clientMessageId),
            }),
      });
      return;
    case "target_recovered":
      await operationalLog.append("oracle_approval_conversation_mirror_recovered", details);
      return;
    case "target_released":
      await operationalLog.append("oracle_approval_conversation_mirror_released", details);
      return;
    case "watcher_error":
      await operationalLog.append("oracle_approval_watcher_error", details);
      // A dead SSH/CDP forward commonly surfaces first as a generic fetch
      // abort before the watcher reaches its unhealthy threshold. Recover the
      // owned forward on that first transport-class failure; target-local CDP
      // command timeouts, target-local session failures, and ChatGPT server
      // responses remain isolated and are deliberately excluded by the
      // event-aware recovery classifier.
      if (oracleApprovalWatcherEventRequiresTunnelRecovery(event)) {
        startOracleRemoteCdpTunnelRecovery(
          new Error(event.error ?? "Oracle CDP watcher transport failed"),
          runtime.transport,
        );
      }
      return;
    case "watcher_unhealthy":
      await operationalLog.append("oracle_approval_watcher_unhealthy", details);
      if (oracleApprovalWatcherEventRequiresTunnelRecovery(event)) {
        startOracleRemoteCdpTunnelRecovery(
          new Error(event.error ?? "Oracle CDP watcher unhealthy"),
          runtime.transport,
        );
      }
      return;
    case "watcher_stopped":
      await operationalLog.append("oracle_approval_watcher_stopped", details);
  }
}

/**
 * A live ssh.exe is not proof that an established local forward is healthy.
 * When the watcher observes transport failures (not remote-response delays),
 * recycle only the owned Oracle watcher and SSH forward. The gateway, Codex Desktop, local Chrome,
 * and the remote trading runtime remain untouched. The normal background
 * startup loop then proves /json/version before creating a new watcher.
 */
function startOracleRemoteCdpTunnelRecovery(
  initialError: Error,
  transport: OracleTransportRuntime,
): void {
  if (stopping || transport.recoveryTask !== undefined) {
    return;
  }
  transport.startupAbort?.abort(initialError);
  const task = (async () => {
    // Finish a concurrent startup before replacing its transport. Otherwise
    // its still-present single-flight handle can suppress the replacement.
    await transport.startupTask?.catch(() => undefined);
    await operationalLog
      .append("oracle_remote_cdp_tunnel_failed", {
        error: initialError.message,
        cdpEndpoint: transport.binding.cdpEndpoint,
        phase: "watcher_transport_recovery",
        gatewayContinues: true,
      })
      .catch(() => undefined);
    await Promise.all(
      oracleBindingRuntimes
        .filter((runtime) => runtime.transport === transport)
        .map(async (runtime) => {
          const watcher = runtime.watcher;
          delete runtime.watcher;
          delete runtime.client;
          delete runtime.eventSource;
          await watcher?.stop().catch(() => undefined);
        }),
    );
    await stopOracleApprovalOwnershipGuard(transport);
    const supervisor = transport.supervisor;
    if (transport.supervisor === supervisor) delete transport.supervisor;
    await supervisor?.stop().catch(() => undefined);
    if (!stopping) startOracleRemoteCdpTunnelInBackground(transport);
  })().finally(() => {
    if (transport.recoveryTask === task) delete transport.recoveryTask;
  });
  transport.recoveryTask = task;
}

async function recoverNgrokTunnel(
  supervisor: NgrokTunnelSupervisor,
  address: NonNullable<OmniCodexDaemonState["address"]>,
  initialError: Error,
): Promise<void> {
  tunnelLastError = initialError;
  lifecycle = daemonLifecycleForGatewayStatus(service.status.lifecycle, bootstrapComplete);
  await persistState({ error: initialError.message }, ["tunnel", "tunnelOwnership"]).catch(
    () => undefined,
  );
  await operationalLog
    .append("ngrok_tunnel_recovery_started", { error: initialError.message })
    .catch(() => undefined);
  let lastError = initialError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (stopping) return;
    await delay(attempt * 1_000);
    if (stopping) return;
    try {
      const recovered = await supervisor.restart(address);
      if (stopping) return;
      tunnelLastError = undefined;
      lifecycle = daemonLifecycleForGatewayStatus(service.status.lifecycle, bootstrapComplete);
      await persistState(
        {
          tunnel: {
            kind: recovered.kind,
            publicUrl: recovered.publicUrl,
            pid: recovered.pid,
          },
        },
        ["error"],
      );
      await operationalLog.append("ngrok_tunnel_recovery_completed", {
        attempt,
        pid: recovered.pid,
      });
      markOracleActionCatalogEndpointReady(true);
      return;
    } catch (error) {
      lastError = toError(error);
      tunnelLastError = lastError;
      await operationalLog
        .append("ngrok_tunnel_recovery_attempt_failed", {
          attempt,
          error: lastError.message,
        })
        .catch(() => undefined);
    }
  }
  await operationalLog
    .append("ngrok_tunnel_recovery_exhausted", { error: lastError.message })
    .catch(() => undefined);
  lifecycle = daemonLifecycleForGatewayStatus(service.status.lifecycle, bootstrapComplete);
  await persistState({ error: lastError.message }, ["tunnel", "tunnelOwnership"]).catch(
    () => undefined,
  );
}

async function recoverCodexRuntime(initialError: Error): Promise<void> {
  await operationalLog
    .append("codex_runtime_recovery_started", { error: initialError.message })
    .catch(() => undefined);
  lifecycle = "starting";
  await persistState({ error: initialError.message }).catch(() => undefined);
  await recoverDesktopRuntimeUntilReady({
    isStopping: () => stopping,
    wait: delay,
    recover: async (attempt) => {
      const recovered = await service.recoverRuntime();
      if (stopping) return;
      // Runtime recovery may rebind the loopback gateway to another port.
      // Keep the existing tunnel supervisor, but move its target before reporting ready.
      const recoveredTunnel =
        recovered.lifecycle === "ready" &&
        recovered.address !== undefined &&
        tunnelSupervisor !== undefined
          ? await tunnelSupervisor.restart(recovered.address).catch(async (error: unknown) => {
              tunnelLastError = toError(error);
              await operationalLog
                .append("external_tunnel_start_failed", {
                  kind: config.tunnel?.kind ?? "unknown",
                  error: tunnelLastError.message,
                  gatewayContinues: true,
                })
                .catch(() => undefined);
              return undefined;
            })
          : undefined;
      if (stopping) return;
      if (recoveredTunnel !== undefined) tunnelLastError = undefined;
      lifecycle = recovered.lifecycle === "ready" ? "ready" : "starting";
      await persistState(
        {
          ...(recovered.address === undefined ? {} : { address: recovered.address }),
          ...(recoveredTunnel === undefined
            ? {}
            : {
                tunnel: {
                  kind: recoveredTunnel.kind,
                  publicUrl: recoveredTunnel.publicUrl,
                  pid: recoveredTunnel.pid,
                },
              }),
          ...(recovered.candidate === undefined
            ? {}
            : { runtimePath: recovered.candidate.canonicalPath }),
          ...(tunnelLastError === undefined ? {} : { error: tunnelLastError.message }),
          ...(recovered.lastError === undefined ? {} : { error: recovered.lastError }),
        },
        recovered.lifecycle === "ready" && tunnelLastError === undefined
          ? ["error"]
          : tunnelLastError === undefined
            ? []
            : ["tunnel", "tunnelOwnership"],
      );
      await operationalLog.append("codex_runtime_recovery_completed", {
        attempt,
        runtimePath: recovered.candidate?.canonicalPath ?? "unknown",
        bridgeRegistryCurrent: recovered.bridgeRegistryCurrent === true,
        ...(recovered.lastError === undefined ? {} : { error: recovered.lastError }),
      });
    },
    onFailure: async (error, attempt) => {
      const lastError = toError(error);
      await operationalLog
        .append("codex_runtime_recovery_attempt_failed", {
          attempt,
          error: lastError.message,
        })
        .catch(() => undefined);
    },
  });
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolveDelay, rejectDelay) => {
    const onAbort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function startControlServer(
  pipe: string,
  token: string,
  identity: DaemonControlIdentity,
  getLifecycle: () => OmniCodexDaemonState["lifecycle"],
  onStop: (timeoutMs?: number) => Promise<void>,
  onRuntimeControl: (
    command: DaemonRuntimeControlCommand,
    timeoutMs?: number,
    targetRuntimePath?: string,
    clientBinding?: string,
    conversationUrl?: string,
    signal?: AbortSignal,
  ) => Promise<DaemonRuntimeControlResult> | DaemonRuntimeControlResult,
): Promise<Server> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    handleControlSocket(socket, token, identity, getLifecycle, onStop, onRuntimeControl);
  });
  controlSocketsByServer.set(server, sockets);
  await new Promise<void>((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(pipe, () => {
      server.removeListener("error", rejectStart);
      resolveStart();
    });
  });
  return server;
}

interface DaemonControlIdentity {
  readonly pid: number;
  readonly instanceNonce: string;
  readonly startedAtUnixMs: number;
}

type DaemonRuntimeControlCommand =
  | "refresh-action-catalog"
  | "begin-drain"
  | "await-drained"
  | "resume-admission"
  | "switch-runtime"
  | "catalog-baseline"
  | "thread-inventory"
  | "desktop-chat-events"
  | "observe-goal-conversation"
  | "oracle-runtime-status";

type DaemonRuntimeControlResult =
  | {
      readonly goalObservation: {
        readonly conversationUrl: string;
        readonly outcome: string;
        readonly observedGoals: readonly string[];
      };
    }
  | { readonly actionCatalog: OracleClientBindingsActionCatalogAutoRefreshResult }
  | {
      readonly admission: "open" | "draining";
      readonly activeMcpRequests: number;
      readonly runtimePath?: string;
    }
  | { readonly catalogBaseline: OmniCodexFullCatalogSnapshot }
  | OmniCodexThreadInventorySnapshot
  | { readonly oracle: OracleDaemonRuntimeStatus }
  | { readonly desktopChatEvents: DesktopChatEventObservationStatus };

function handleControlSocket(
  socket: Socket,
  token: string,
  identity: DaemonControlIdentity,
  getLifecycle: () => OmniCodexDaemonState["lifecycle"],
  onStop: (timeoutMs?: number) => Promise<void>,
  onRuntimeControl: (
    command: DaemonRuntimeControlCommand,
    timeoutMs?: number,
    targetRuntimePath?: string,
    clientBinding?: string,
    conversationUrl?: string,
    signal?: AbortSignal,
  ) => Promise<DaemonRuntimeControlResult> | DaemonRuntimeControlResult,
): void {
  socket.setEncoding("utf8");
  let input = "";
  let handled = false;
  socket.on("data", (chunk: string) => {
    if (handled) return;
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    handled = true;
    try {
      const request: unknown = JSON.parse(input.slice(0, newline));
      if (
        !isObject(request) ||
        request.token !== token ||
        request.expectedPid !== identity.pid ||
        request.expectedInstanceNonce !== identity.instanceNonce ||
        request.expectedStartedAtUnixMs !== identity.startedAtUnixMs ||
        !isControlCommand(request.command)
      ) {
        socket.end(`${JSON.stringify({ ok: false, ...identity, lifecycle: getLifecycle() })}\n`);
        return;
      }
      const command = request.command;
      const clientBinding =
        (command === "refresh-action-catalog" || command === "observe-goal-conversation") &&
        typeof request.clientBinding === "string"
          ? request.clientBinding
          : undefined;
      if (
        command === "refresh-action-catalog" &&
        request.clientBinding !== undefined &&
        (clientBinding === undefined || clientBinding.trim().length === 0)
      ) {
        socket.end(
          `${JSON.stringify({ ok: false, ...identity, lifecycle: getLifecycle(), error: "Invalid client binding" })}\n`,
        );
        return;
      }
      const acceptsDrainTimeout =
        command === "stop" ||
        command === "begin-drain" ||
        command === "await-drained" ||
        command === "switch-runtime";
      const timeoutMs = acceptsDrainTimeout ? validDrainTimeout(request.timeoutMs) : undefined;
      if (acceptsDrainTimeout && request.timeoutMs !== undefined && timeoutMs === undefined) {
        socket.end(
          `${JSON.stringify({ ok: false, ...identity, lifecycle: getLifecycle(), error: "Invalid drain timeout" })}\n`,
        );
        return;
      }
      const targetRuntimePath =
        command === "switch-runtime" ? validRuntimePath(request.targetRuntimePath) : undefined;
      if (command === "switch-runtime" && targetRuntimePath === undefined) {
        socket.end(
          `${JSON.stringify({ ok: false, ...identity, lifecycle: getLifecycle(), error: "Invalid runtime target" })}\n`,
        );
        return;
      }
      void (async () => {
        const controller = new AbortController();
        let operationSettled = false;
        const abortOnDisconnect = () => {
          if (!operationSettled) {
            controller.abort(new Error("DAEMON_CONTROL_CLIENT_DISCONNECTED"));
          }
        };
        socket.once("close", abortOnDisconnect);
        try {
          const conversationUrl =
            command === "observe-goal-conversation" && typeof request.conversationUrl === "string"
              ? normalizeChatGptConversationUrl(request.conversationUrl)
              : undefined;
          if (
            command === "observe-goal-conversation" &&
            (!clientBinding?.trim() || conversationUrl === undefined)
          )
            throw new Error("ORACLE_GOAL_OBSERVATION_TARGET_INVALID");
          const runtime =
            command === "status" || command === "stop"
              ? undefined
              : await onRuntimeControl(
                  command,
                  timeoutMs,
                  targetRuntimePath,
                  clientBinding,
                  conversationUrl,
                  controller.signal,
                );
          operationSettled = true;
          socket.removeListener("close", abortOnDisconnect);
          const response = `${JSON.stringify({ ok: true, ...identity, lifecycle: getLifecycle(), ...(runtime === undefined ? {} : { runtime }) })}\n`;
          if (command === "stop") {
            // Flush the authenticated success proof before shutdown closes the
            // control server. Starting shutdown immediately after socket.end()
            // can retire the daemon while the CLI is still waiting for bytes,
            // leaving its top-level restart promise permanently unsettled.
            socket.end(response, () => void onStop(timeoutMs));
          } else {
            socket.end(response);
          }
        } catch (error) {
          operationSettled = true;
          socket.removeListener("close", abortOnDisconnect);
          socket.end(
            `${JSON.stringify({ ok: false, ...identity, lifecycle: getLifecycle(), error: toError(error).message })}\n`,
          );
        }
      })();
    } catch {
      socket.end(`${JSON.stringify({ ok: false, ...identity, lifecycle: getLifecycle() })}\n`);
    }
  });
}

function isControlCommand(
  value: unknown,
): value is
  | "refresh-action-catalog"
  | "status"
  | "stop"
  | "begin-drain"
  | "await-drained"
  | "resume-admission"
  | "switch-runtime"
  | "catalog-baseline"
  | "thread-inventory"
  | "desktop-chat-events"
  | "observe-goal-conversation"
  | "oracle-runtime-status" {
  return (
    value === "refresh-action-catalog" ||
    value === "status" ||
    value === "stop" ||
    value === "begin-drain" ||
    value === "await-drained" ||
    value === "resume-admission" ||
    value === "switch-runtime" ||
    value === "catalog-baseline" ||
    value === "thread-inventory" ||
    value === "desktop-chat-events" ||
    value === "observe-goal-conversation" ||
    value === "oracle-runtime-status"
  );
}

function validDrainTimeout(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function validRuntimePath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    return undefined;
  }
  return resolve(value);
}

async function closeControlServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) rejectClose(error);
      else resolveClose();
    });
    // The authenticated control pipe is daemon-owned and every accepted
    // command is one request per socket. A crashed/abandoned inspector can
    // otherwise keep server.close() pending forever after the runtime, tunnel,
    // and watcher have already stopped. Refuse new connections first, then
    // retire only this server's remaining control sockets.
    for (const socket of controlSocketsByServer.get(server) ?? []) socket.destroy();
  });
  controlSocketsByServer.delete(server);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function shutdownErrorSummary(value: unknown): string {
  const error = toError(value);
  if (!(error instanceof AggregateError)) return error.message;
  const nested = [...error.errors]
    .map(shutdownErrorSummary)
    .filter((message) => message.length > 0);
  return nested.length === 0 ? error.message : `${error.message}: ${nested.join("; ")}`;
}

function runtimeSwitchFailureCode(value: unknown): string {
  if (value instanceof CommittedRuntimeSwitchFailure) return value.reasonCode;
  const message = toError(value).message;
  if (message.startsWith("CODEX_BOUNDARY_")) return "codex_boundary_changed";
  if (message.includes("drain timed out")) return "drain_timeout";
  if (message.includes("observation failed")) return "observation_failed";
  if (message.includes("spawn")) return "candidate_spawn_failed";
  return "candidate_rejected";
}

function requiredInstanceNonce(value: string | undefined): string {
  if (value === undefined || value.length < 32 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("OmniCodex daemon requires a strong launch instance nonce");
  }
  return value;
}

function parseInitialAdmission(value: string | undefined): "open" | "draining" {
  if (value === undefined || value === "open") return "open";
  if (value === "draining") return "draining";
  throw new Error("Invalid OmniCodex initial admission mode");
}
