import { isAbsolute } from "node:path";
import type { ChatGptActionCatalogControlClient } from "../infrastructure/chatgpt/chatgpt-action-catalog-control-client.js";
import {
  type ApprovalWatchResult,
  assertExplicitLoopbackCdpEndpoint,
  ChatGptAppApprovalAdapter,
  type ChatGptApprovalSurface,
  type WatchOptions,
} from "../infrastructure/chatgpt/chatgpt-app-approval-adapter.js";
import {
  ChatGptAppSettingsReconciler,
  type ChatGptSettingsSurface,
  type SettingsConnectAttempt,
  type SettingsReconcileOptions,
  type SettingsReconcileResult,
} from "../infrastructure/chatgpt/chatgpt-app-settings-reconciler.js";
import {
  assertOracleRegistration,
  hasExactActionCatalogContractParity,
  loadOmniCodexConfig,
  OMNICODEX_MCP_SURFACE,
  type OmniCodexConfig,
  type OmniCodexOracleConfig,
  type OmniCodexOracleRegistration,
  omniCodexConfigPath,
  saveOmniCodexConfig,
  selectOracleClientConfig,
  withOracleClientBinding,
} from "../infrastructure/config/omnicodex-config-store.js";
import type { OmniCodexFullCatalogSnapshot } from "../infrastructure/mcp/omnicodex-mcp-server.js";
import {
  type AuthoritativeActionRefreshOptions,
  type AuthoritativeActionRefreshResult,
  ChatGptActionCatalogRefreshVerifier,
} from "../infrastructure/operations/chatgpt-action-catalog-refresh-verifier.js";
import { canonicalJson } from "../infrastructure/safety/canonical-json.js";
import { withDaemonLifecycleLock } from "./daemon-state-recovery.js";
import { oracleActionCatalogMatchesBaseline } from "./oracle-action-catalog-auto-refresh.js";
export interface OracleSetupInput {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly runId: string;
  readonly resource: string;
  readonly endpoint?: string;
  readonly registration?: OmniCodexOracleRegistration;
  readonly actionVersionId?: string;
  readonly surface: typeof OMNICODEX_MCP_SURFACE;
  readonly cdpEndpoint: string;
  /** Omit to preserve a matching endpoint's transport; null selects direct CDP. */
  readonly remoteCdpTunnel?: NonNullable<OmniCodexOracleConfig["remoteCdpTunnel"]> | null;
}
// Config writes from independent Web/Desktop service instances share one queue.
// The queued operation reloads the latest config before merging its own binding.
let bindingWriteQueue: Promise<void> = Promise.resolve();
export class OracleAdapterService {
  readonly #load: () => Promise<OmniCodexConfig>;
  readonly #loadAll: () => Promise<OmniCodexConfig>;
  readonly #save: (
    c: OmniCodexConfig,
    expected: OmniCodexOracleConfig | undefined,
  ) => Promise<void>;
  readonly #clientBinding: string;
  constructor(
    ports: {
      load?: () => Promise<OmniCodexConfig>;
      save?: (c: OmniCodexConfig) => Promise<void>;
      clientBinding?: string;
      configPath?: string;
    } = {},
  ) {
    this.#clientBinding = ports.clientBinding ?? "web";
    this.#loadAll = ports.load ?? (() => loadOmniCodexConfig(ports.configPath));
    const save = ports.save ?? ((c: OmniCodexConfig) => saveOmniCodexConfig(c, ports.configPath));
    this.#load = async () => selectOracleClientConfig(await this.#loadAll(), this.#clientBinding);
    this.#save = async (selected, expected) => {
      if (selected.oracle === undefined) throw new Error("Oracle client binding is missing");
      const binding = selected.oracle;
      const merge = async () => {
        const latest = await this.#loadAll();
        const currentBinding = selectOracleClientConfig(latest, this.#clientBinding).oracle;
        // Validate inside the same process/file lock as the write. A refresh
        // receipt must never resurrect a disabled or replaced registration,
        // or erase a newer receipt while waiting for another binding's write.
        if (canonicalJson(currentBinding ?? null) !== canonicalJson(expected ?? null)) {
          throw new Error("ORACLE_BINDING_CHANGED_BEFORE_PERSIST");
        }
        await save(withOracleClientBinding(latest, this.#clientBinding, binding));
      };
      const write = bindingWriteQueue.then(() =>
        ports.load !== undefined || ports.save !== undefined
          ? merge()
          : withDaemonLifecycleLock(merge, {
              statePath: `${ports.configPath ?? omniCodexConfigPath()}.client-bindings`,
              waitOnContention: true,
            }),
      );
      bindingWriteQueue = write.catch(() => undefined);
      await write;
    };
  }
  async setup(
    input: OracleSetupInput,
    execute = false,
  ): Promise<{ executed: boolean; oracle: OmniCodexOracleConfig }> {
    assertExplicitLoopbackCdpEndpoint(input.cdpEndpoint);
    assertOracleRegistration(input.registration, input.endpoint);
    for (const value of [input.resource, input.endpoint ?? input.resource]) {
      const resource = new URL(value);
      if (
        resource.protocol !== "https:" ||
        resource.username !== "" ||
        resource.password !== "" ||
        resource.pathname !== OMNICODEX_MCP_SURFACE ||
        resource.search !== "" ||
        resource.hash !== ""
      ) {
        throw new Error(`Oracle resource must be the ${OMNICODEX_MCP_SURFACE} HTTPS surface`);
      }
    }
    if (input.surface !== OMNICODEX_MCP_SURFACE) {
      throw new Error("Oracle binding must target the OmniCodex full-access surface");
    }
    for (const value of [input.connectorId, input.connectorName, input.runId])
      if (value.trim() === "") throw new Error("Exact Oracle binding values are required");
    const current = execute ? await this.#load() : undefined;
    const prior = current?.oracle;
    const transport = prior ?? (execute ? (await this.#loadAll()).oracle : undefined);
    if (
      input.remoteCdpTunnel === undefined &&
      transport?.remoteCdpTunnel !== undefined &&
      new URL(transport.cdpEndpoint).href !== new URL(input.cdpEndpoint).href
    )
      throw new Error(
        "ORACLE_CDP_TRANSPORT_REQUIRED: specify remote SSH transport or direct CDP for a different endpoint",
      );
    const remoteCdpTunnel =
      input.remoteCdpTunnel === null
        ? undefined
        : (input.remoteCdpTunnel ?? transport?.remoteCdpTunnel);
    if (
      remoteCdpTunnel !== undefined &&
      ([remoteCdpTunnel.sshHost, remoteCdpTunnel.sshUser, remoteCdpTunnel.identityFile].some(
        (value) => typeof value !== "string" || value.trim() === "",
      ) ||
        !isAbsolute(remoteCdpTunnel.identityFile) ||
        [remoteCdpTunnel.sshPort, remoteCdpTunnel.remoteCdpPort].some(
          (value) => !Number.isInteger(value) || value < 1 || value > 65_535,
        ))
    )
      throw new Error("ORACLE_CDP_TRANSPORT_INVALID");
    const sameConnector =
      prior !== undefined &&
      sameConnectorBinding(prior, input) &&
      canonicalJson(prior.remoteCdpTunnel ?? null) === canonicalJson(remoteCdpTunnel ?? null);
    const endpoint =
      input.registration === undefined
        ? (input.endpoint ?? (sameConnector ? prior.endpoint : undefined) ?? input.resource)
        : undefined;
    const actionVersionId =
      input.actionVersionId ?? (sameConnector ? prior.actionVersionId : undefined);
    const oracle: OmniCodexOracleConfig = {
      enabled: true,
      connectorId: input.connectorId,
      connectorName: input.connectorName,
      runId: input.runId,
      resource: input.resource,
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(input.registration === undefined ? {} : { registration: { ...input.registration } }),
      ...(actionVersionId === undefined ? {} : { actionVersionId }),
      surface: input.surface,
      cdpEndpoint: input.cdpEndpoint,
      // Connector updates retain the same endpoint's transport. A distinct
      // endpoint uses the explicitly selected remote tunnel or direct CDP.
      ...(remoteCdpTunnel === undefined ? {} : { remoteCdpTunnel }),
      freshLiveVerification: sameConnector ? prior.freshLiveVerification : "pending",
      ...(sameConnector && prior.lastReceipts !== undefined
        ? { lastReceipts: prior.lastReceipts }
        : {}),
      ...(sameConnector && prior.lastStateVerification !== undefined
        ? { lastStateVerification: prior.lastStateVerification }
        : {}),
      ...(sameConnector && prior.lastActionCatalogVerification !== undefined
        ? { lastActionCatalogVerification: prior.lastActionCatalogVerification }
        : {}),
    };
    if (execute) {
      const config = current ?? (await this.#load());
      await this.#save({ ...config, oracle }, config.oracle);
      const readback = await this.#load();
      if (JSON.stringify(readback.oracle) !== JSON.stringify(oracle))
        throw new Error("Oracle config authoritative readback failed");
    }
    return { executed: execute, oracle };
  }
  async status(liveCatalog?: OmniCodexFullCatalogSnapshot) {
    const config = await this.#load();
    const oracle = config.oracle;
    const expectedResource =
      config.auth.resource ??
      (config.auth.audience
        ? new URL(OMNICODEX_MCP_SURFACE, config.auth.audience).href
        : undefined);
    const expectedEndpoint =
      config.tunnel === undefined
        ? expectedResource
        : new URL(OMNICODEX_MCP_SURFACE, config.tunnel.publicUrl).href;
    const secureTunnel = oracle?.registration?.kind === "secure_mcp_tunnel";
    const bindingResourceCurrent = oracle !== undefined && oracle.resource === expectedResource;
    const bindingEndpointCurrent = secureTunnel
      ? null
      : bindingResourceCurrent && (oracle?.endpoint ?? oracle?.resource) === expectedEndpoint;
    const storedCatalogActivated =
      oracle?.freshLiveVerification === "verified" &&
      oracle.lastStateVerification !== undefined &&
      hasExactActionCatalogContractParity(oracle.lastActionCatalogVerification);
    // The complete native registry can acquire a new revision while ChatGPT's
    // deliberately stable eager action surface remains byte-for-byte the same.
    // Activation therefore follows exact action count/name parity instead of
    // an unrelated full-registry revision string.
    const catalogActivated =
      storedCatalogActivated &&
      bindingResourceCurrent &&
      (secureTunnel || bindingEndpointCurrent === true) &&
      (liveCatalog === undefined || oracleActionCatalogMatchesBaseline(config, liveCatalog));
    return {
      clientBinding: this.#clientBinding,
      bindingEndpointCurrent,
      bindingResourceCurrent,
      ...(secureTunnel ? { tunnelLiveReadiness: "unverified" as const } : {}),
      configurationReady:
        oracle?.enabled === true &&
        bindingResourceCurrent &&
        (secureTunnel || bindingEndpointCurrent === true),
      enabled: oracle?.enabled === true,
      complete:
        oracle !== undefined &&
        [
          oracle.connectorId,
          oracle.connectorName,
          oracle.runId,
          oracle.resource,
          oracle.surface,
          oracle.cdpEndpoint,
        ].every((v) => v.length > 0) &&
        catalogActivated &&
        !secureTunnel,
      cdpEndpointValid: oracle === undefined ? false : safeEndpoint(oracle.cdpEndpoint),
      freshLiveVerification: catalogActivated ? "verified" : "pending",
      catalogActivated,
      storedCatalogActivated,
      ...(liveCatalog === undefined
        ? {}
        : {
            liveCatalogRevision: liveCatalog.catalogRevision,
            liveActionToolCount: liveCatalog.chatGptActionToolCount,
          }),
      lastReceipts: oracle?.lastReceipts ?? [],
      config: oracle === undefined ? null : { ...oracle, lastReceipts: undefined },
    };
  }
  async reconcile(
    surface: ChatGptSettingsSurface,
    execute = false,
    identity: { sessionId?: string; correlationId?: string } = {},
    options: Pick<SettingsReconcileOptions, "timeoutMs" | "pollIntervalMs" | "signal"> = {},
  ): Promise<SettingsReconcileResult> {
    const config = await this.#load();
    const o = config.oracle;
    if (o?.enabled !== true) throw new Error("Oracle adapter is disabled");
    const binding = oracleBinding(o, identity);
    const persistConnectAttempt = async (attempt: SettingsConnectAttempt): Promise<void> => {
      const current = await this.#load();
      if (current.oracle === undefined || !sameOracleBinding(current.oracle, o)) {
        throw new Error("ORACLE_BINDING_CHANGED_DURING_CONNECT_HANDOFF");
      }
      const pendingOracle = { ...current.oracle, pendingConnectAttempt: attempt };
      await this.#save({ ...current, oracle: pendingOracle }, current.oracle);
      const readback = await this.#load();
      if (JSON.stringify(readback.oracle) !== JSON.stringify(pendingOracle)) {
        throw new Error("ORACLE_PENDING_CONNECT_READBACK_FAILED");
      }
    };
    const result = await new ChatGptAppSettingsReconciler(binding).reconcile(surface, {
      dryRun: !execute,
      ...(o.pendingConnectAttempt === undefined
        ? {}
        : { pendingConnectAttempt: o.pendingConnectAttempt }),
      ...(execute ? { onConnectAttempt: persistConnectAttempt } : {}),
      ...options,
    });
    if (!execute) return result;
    const current = await this.#load();
    if (current.oracle === undefined || !sameOracleBinding(current.oracle, o)) {
      throw new Error("ORACLE_BINDING_CHANGED_DURING_RECONCILE");
    }
    const lastReceipts = mergeReceipts(
      current.oracle.lastReceipts ?? [],
      result.receipts.map(storedReceipt),
    );
    const { pendingConnectAttempt: _completedAttempt, ...oracleWithoutPendingAttempt } =
      current.oracle;
    const priorCatalogStillMatches =
      oracleWithoutPendingAttempt.freshLiveVerification === "verified" &&
      hasExactActionCatalogContractParity(
        oracleWithoutPendingAttempt.lastActionCatalogVerification,
      ) &&
      oracleWithoutPendingAttempt.lastStateVerification?.resource === o.resource &&
      oracleWithoutPendingAttempt.lastStateVerification?.stateHash === result.stateHash;
    const { lastActionCatalogVerification: priorCatalog, ...oracleWithoutCatalog } =
      oracleWithoutPendingAttempt;
    const reconciledOracle = {
      ...oracleWithoutCatalog,
      ...(lastReceipts.length === 0 ? {} : { lastReceipts }),
      lastStateVerification: {
        timestamp: new Date().toISOString(),
        correlationId: binding.correlationId,
        resource: o.resource,
        connected: true as const,
        fullAccess: true as const,
        stateHash: result.stateHash,
      },
      ...(priorCatalogStillMatches && priorCatalog !== undefined
        ? { lastActionCatalogVerification: priorCatalog }
        : {}),
      freshLiveVerification: priorCatalogStillMatches
        ? ("verified" as const)
        : ("pending" as const),
    };
    await this.#save({ ...current, oracle: reconciledOracle }, current.oracle);
    const readback = await this.#load();
    if (JSON.stringify(readback.oracle) !== JSON.stringify(reconciledOracle)) {
      throw new Error("ORACLE_RECONCILE_RECEIPT_READBACK_FAILED");
    }
    return result;
  }
  async refreshActions(
    surface: ChatGptSettingsSurface,
    identity: { sessionId?: string; correlationId?: string } = {},
    options: AuthoritativeActionRefreshOptions = {},
  ): Promise<AuthoritativeActionRefreshResult> {
    const config = await this.#load();
    const oracle = config.oracle;
    if (oracle?.enabled !== true) throw new Error("Oracle adapter is disabled");
    const result = await new ChatGptActionCatalogRefreshVerifier().verify(
      surface,
      oracleBinding(oracle, identity),
      options,
    );
    await this.#persistActionRefresh(oracle, identity, result);
    return result;
  }
  async refreshActionsControlPlane(
    client: ChatGptActionCatalogControlClient,
    identity: { sessionId?: string; correlationId?: string } = {},
    options: AuthoritativeActionRefreshOptions = {},
  ): Promise<AuthoritativeActionRefreshResult> {
    const config = await this.#load();
    const oracle = config.oracle;
    if (oracle?.enabled !== true) throw new Error("Oracle adapter is disabled");
    const result = await new ChatGptActionCatalogRefreshVerifier().verifyControlPlane(
      client,
      oracleBinding(oracle, identity),
      options,
    );
    await this.#persistActionRefresh(oracle, identity, result);
    return result;
  }
  async #persistActionRefresh(
    oracle: OmniCodexOracleConfig,
    identity: { sessionId?: string; correlationId?: string },
    result: AuthoritativeActionRefreshResult,
  ): Promise<void> {
    const evidence = result.operationalEvidence;
    if (evidence === undefined) return;
    const current = await this.#load();
    if (current.oracle === undefined || !sameOracleBinding(current.oracle, oracle)) {
      throw new Error("ORACLE_BINDING_CHANGED_DURING_ACTION_REFRESH");
    }
    const correlationId = identity.correlationId ?? oracle.runId;
    const verifiedOracle = {
      ...current.oracle,
      lastStateVerification: {
        timestamp: new Date().toISOString(),
        correlationId,
        resource: oracle.resource,
        connected: true as const,
        fullAccess: true as const,
        stateHash: result.stateHash,
      },
      lastActionCatalogVerification: {
        timestamp: new Date().toISOString(),
        correlationId,
        verificationSource: evidence.source,
        daemonPid: evidence.daemonPid,
        catalogRevision: evidence.catalogRevision,
        catalogToolCount: evidence.catalogToolCount,
        catalogPageToolCounts: evidence.catalogPageToolCounts,
        catalogToolNamesSha256: evidence.catalogToolNamesSha256,
        catalogContractSha256: evidence.actionContractSha256,
        visibleActionToolCount: result.actionSnapshotEvidence.visibleActionToolCount,
        visibleActionNamesSha256: result.actionSnapshotEvidence.visibleActionNamesSha256,
        actionSchemaHash: result.actionSchemaHash,
        verifiedActionNames: result.verifiedActionNames,
      },
      freshLiveVerification: "verified" as const,
    };
    await this.#save({ ...current, oracle: verifiedOracle }, current.oracle);
    const readback = await this.#load();
    if (JSON.stringify(readback.oracle) !== JSON.stringify(verifiedOracle)) {
      throw new Error("ORACLE_ACTION_REFRESH_READBACK_FAILED");
    }
  }
  async test(
    surface: ChatGptApprovalSurface,
    execute = false,
    identity: { runId?: string; sessionId?: string; correlationId?: string } = {},
    watchOptions: Pick<WatchOptions, "timeoutMs" | "pollIntervalMs" | "maxRetries"> = {},
  ): Promise<ApprovalWatchResult> {
    const config = await this.#load();
    const o = config.oracle;
    if (o?.enabled !== true) throw new Error("Oracle adapter is disabled");
    const binding = oracleBinding(o, identity);
    const result = await new ChatGptAppApprovalAdapter(binding).watch(surface, {
      dryRun: !execute,
      ...watchOptions,
    });
    if (execute) {
      const incomingReceipts = result.receipts.map(storedReceipt);
      const observedReceipts = mergeReceipts(o.lastReceipts ?? [], incomingReceipts);
      const incomingActions = new Set(incomingReceipts.map((receipt) => receipt.action));
      const incomingExactCorrelation = incomingReceipts.every(
        (receipt) => receipt.correlationId === binding.correlationId,
      );
      const incomingPersistentReceipt = incomingReceipts.find(
        (receipt) => receipt.action === "always_allow",
      );
      const priorConnectorQualification =
        o.freshLiveVerification === "verified" &&
        hasExactActionCatalogContractParity(o.lastActionCatalogVerification) &&
        hasFullConsentReceipts(o.lastReceipts ?? []);
      const currentConversationQualified =
        incomingActions.has("connect") &&
        incomingActions.has("always_allow") &&
        incomingPersistentReceipt?.consentStrength !== "low_risk";
      if (
        result.state !== "tool_result" ||
        !incomingExactCorrelation ||
        (!priorConnectorQualification && !currentConversationQualified)
      ) {
        throw new Error("ORACLE_REQUIRED_CONSENT_SEQUENCE_NOT_OBSERVED");
      }
      const current = await this.#load();
      if (current.oracle === undefined || !sameOracleBinding(current.oracle, o)) {
        throw new Error("ORACLE_BINDING_CHANGED_DURING_WATCH");
      }
      const verifiedOracle = {
        ...current.oracle,
        lastReceipts: observedReceipts,
        freshLiveVerification: hasExactActionCatalogContractParity(
          current.oracle.lastActionCatalogVerification,
        )
          ? ("verified" as const)
          : ("pending" as const),
      };
      await this.#save({ ...current, oracle: verifiedOracle }, current.oracle);
      const readback = await this.#load();
      if (JSON.stringify(readback.oracle) !== JSON.stringify(verifiedOracle)) {
        throw new Error("ORACLE_RECEIPT_AUTHORITATIVE_READBACK_FAILED");
      }
    }
    return result;
  }
  async disable(execute = false) {
    const config = await this.#load();
    if (!execute) return { executed: false, enabled: false };
    if (config.oracle === undefined) return { executed: true, enabled: false };
    await this.#save({ ...config, oracle: { ...config.oracle, enabled: false } }, config.oracle);
    const readback = await this.#load();
    if (readback.oracle?.enabled !== false) throw new Error("Oracle disable readback failed");
    return { executed: true, enabled: false };
  }
}

type StoredOracleReceipt = NonNullable<OmniCodexOracleConfig["lastReceipts"]>[number];

function oracleBinding(
  oracle: OmniCodexOracleConfig,
  identity: { runId?: string; sessionId?: string; correlationId?: string },
) {
  return {
    appConnectorId: oracle.connectorId,
    appName: oracle.connectorName,
    oracleRunId: identity.runId ?? oracle.runId,
    sessionId: identity.sessionId ?? oracle.runId,
    correlationId: identity.correlationId ?? oracle.runId,
    mcpServerResource: oracle.resource,
    mcpSurface: oracle.surface,
  };
}

function hasFullConsentReceipts(receipts: readonly StoredOracleReceipt[]): boolean {
  const connect = receipts.find((receipt) => receipt.action === "connect");
  const persistent = receipts.find((receipt) => receipt.action === "always_allow");
  return (
    connect?.consentStrength === "connection" &&
    (persistent?.consentStrength === "persistent" || persistent?.consentStrength === "full_access")
  );
}

function storedReceipt(receipt: {
  readonly timestamp: string;
  readonly action: StoredOracleReceipt["action"];
  readonly consentStrength: StoredOracleReceipt["consentStrength"];
  readonly evidenceSource: StoredOracleReceipt["evidenceSource"];
  readonly correlationId: string;
  readonly beforeStateHash: string;
  readonly afterStateHash: string;
}): StoredOracleReceipt {
  return {
    timestamp: receipt.timestamp,
    action: receipt.action,
    consentStrength: receipt.consentStrength,
    evidenceSource: receipt.evidenceSource,
    correlationId: receipt.correlationId,
    beforeStateHash: receipt.beforeStateHash,
    afterStateHash: receipt.afterStateHash,
  };
}

function mergeReceipts(
  existing: readonly StoredOracleReceipt[],
  incoming: readonly StoredOracleReceipt[],
): readonly StoredOracleReceipt[] {
  const byAction = new Map<StoredOracleReceipt["action"], StoredOracleReceipt>();
  for (const receipt of [...existing, ...incoming]) byAction.set(receipt.action, receipt);
  return (["connect", "always_allow"] as const)
    .map((action) => byAction.get(action))
    .filter((receipt): receipt is StoredOracleReceipt => receipt !== undefined);
}

function sameConnectorBinding(existing: OmniCodexOracleConfig, input: OracleSetupInput): boolean {
  return (
    existing.connectorId === input.connectorId &&
    existing.connectorName === input.connectorName &&
    existing.resource === input.resource &&
    canonicalJson(existing.registration ?? null) === canonicalJson(input.registration ?? null) &&
    (input.endpoint === undefined || (existing.endpoint ?? existing.resource) === input.endpoint) &&
    (input.actionVersionId === undefined || existing.actionVersionId === input.actionVersionId) &&
    existing.surface === input.surface &&
    existing.cdpEndpoint === input.cdpEndpoint
  );
}
function safeEndpoint(value: string): boolean {
  try {
    assertExplicitLoopbackCdpEndpoint(value);
    return true;
  } catch {
    return false;
  }
}

function sameOracleBinding(left: OmniCodexOracleConfig, right: OmniCodexOracleConfig): boolean {
  return (
    left.enabled === true &&
    left.connectorId === right.connectorId &&
    left.connectorName === right.connectorName &&
    left.runId === right.runId &&
    left.resource === right.resource &&
    canonicalJson(left.registration ?? null) === canonicalJson(right.registration ?? null) &&
    (left.endpoint ?? left.resource) === (right.endpoint ?? right.resource) &&
    left.actionVersionId === right.actionVersionId &&
    left.surface === right.surface &&
    left.cdpEndpoint === right.cdpEndpoint &&
    canonicalJson(left.remoteCdpTunnel ?? null) === canonicalJson(right.remoteCdpTunnel ?? null)
  );
}
