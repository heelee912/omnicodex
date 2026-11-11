import { createHash } from "node:crypto";
import type {
  ChatGptActionCatalogControlClient,
  ChatGptActionCatalogControlReceipt,
} from "../chatgpt/chatgpt-action-catalog-control-client.js";
import type { ChatGptApprovalBinding } from "../chatgpt/chatgpt-app-approval-adapter.js";
import {
  ChatGptAppSettingsReconciler,
  type ChatGptSettingsSnapshot,
  type ChatGptSettingsSurface,
  OMNICODEX_CRITICAL_ACTION_SCHEMAS,
  type SettingsActionRefreshResult,
} from "../chatgpt/chatgpt-app-settings-reconciler.js";
import type { OmniCodexFullCatalogSnapshot } from "../mcp/omnicodex-mcp-server.js";
import {
  OmniCodexOperationalLog,
  type OmniCodexOperationalLogBatch,
  type OmniCodexOperationalLogCursor,
  type OmniCodexOperationalLogEntry,
} from "./operational-log.js";

const CRITICAL_TOOL_NAME = "call_native_tool";
const criticalActionSchema = OMNICODEX_CRITICAL_ACTION_SCHEMAS.find(
  ({ toolName }) => toolName === CRITICAL_TOOL_NAME,
);
if (criticalActionSchema === undefined) {
  throw new Error("OMNICODEX_CRITICAL_ACTION_SCHEMA_UNAVAILABLE");
}
const CRITICAL_PROPERTIES = criticalActionSchema.inputProperties;
const CRITICAL_REQUIRED = criticalActionSchema.requiredInputProperties;

export interface OperationalCatalogRefreshEvidence {
  readonly source: "post_click_mcp_catalog" | "chatgpt_control_plane_catalog";
  readonly daemonPid: number;
  readonly correlationId: string;
  readonly catalogRevision: string;
  readonly catalogToolCount: number;
  readonly catalogPageToolCounts: readonly number[];
  readonly catalogToolNamesSha256: string;
  /** Complete eager action contract fetched in this refresh generation. */
  readonly actionContractSha256: string;
  readonly criticalToolInputSchemaSha256: string;
  readonly criticalToolDescriptionSha256: string;
  /** The same digest read from the current daemon before the exact Refresh click. */
  readonly expectedLocalInputSchemaSha256: string;
}

export interface AuthoritativeActionRefreshResult extends SettingsActionRefreshResult {
  readonly verificationSource:
    | "chatgpt_dom"
    | "post_click_mcp_catalog"
    | "chatgpt_control_plane_catalog";
  readonly operationalEvidence?: OperationalCatalogRefreshEvidence;
}

export interface AuthoritativeActionRefreshOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly expectedDaemonPid?: number;
  readonly readLocalCatalogBaseline?: () => Promise<LiveLocalCatalogBaseline>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface LiveLocalCatalogBaseline extends OmniCodexFullCatalogSnapshot {
  readonly daemonPid: number;
}

interface OperationalLogPort {
  read(limit?: number): Promise<readonly OmniCodexOperationalLogEntry[]>;
  captureCursor?(): Promise<OmniCodexOperationalLogCursor>;
  readFrom?(cursor: OmniCodexOperationalLogCursor): Promise<OmniCodexOperationalLogBatch>;
}

interface CatalogSequence {
  readonly catalogRevision: string;
  readonly toolCount: number;
  readonly toolNames: readonly string[];
  readonly toolNamesSha256: string;
  readonly actionContractSha256: string;
  readonly criticalToolName: string;
  readonly criticalToolProperties: string;
  readonly criticalToolRequired: string;
  readonly criticalToolDescriptionSha256: string;
  readonly criticalToolInputSchemaSha256: string;
}

interface CatalogCheckpoint {
  readonly capturedAt: string;
  readonly knownCorrelationIds: ReadonlySet<string>;
  readonly expectedDaemonPid?: number;
  readonly expectedSequence?: CatalogSequence;
  readonly logCursor?: OmniCodexOperationalLogCursor;
}

interface RefreshActivation {
  readonly checkpoint: CatalogCheckpoint;
  readonly targetId: string;
  readonly beforeDomRevision: string;
}

/**
 * Verifies ChatGPT's exact app-action Refresh. A `chatgpt_dom` result proves
 * only the selected critical schema rendered after the click. A
 * `post_click_mcp_catalog` result additionally proves a complete post-click
 * traversal of the exact MCP catalog against the live pre-click baseline.
 */
export class ChatGptActionCatalogRefreshVerifier {
  readonly #log: OperationalLogPort;

  constructor(log: OperationalLogPort = new OmniCodexOperationalLog()) {
    this.#log = log;
  }

  async verify(
    surface: ChatGptSettingsSurface,
    binding: ChatGptApprovalBinding,
    options: AuthoritativeActionRefreshOptions = {},
  ): Promise<AuthoritativeActionRefreshResult> {
    const timeoutMs = options.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? 250;
    if ((timeoutMs !== undefined && timeoutMs < 1) || pollIntervalMs < 10) {
      throw new Error("Invalid authoritative action refresh bounds");
    }
    if (options.expectedDaemonPid === undefined || options.readLocalCatalogBaseline === undefined) {
      throw new Error("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED", {
        cause: new Error("MCP_CATALOG_PRE_CLICK_BASELINE_UNAVAILABLE"),
      });
    }
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? boundedDelay;
    const deadline =
      timeoutMs === undefined ? Number.POSITIVE_INFINITY : now().getTime() + timeoutMs;
    const controller = new AbortController();
    const forwardAbort = () =>
      controller.abort(options.signal?.reason ?? new Error("Action refresh aborted"));
    if (options.signal?.aborted === true) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });

    const tracked = new RefreshTrackingSurface(
      surface,
      () => this.#checkpoint(options.expectedDaemonPid, options.readLocalCatalogBaseline, now),
      controller.signal,
    );
    const reconciler = new ChatGptAppSettingsReconciler(binding);
    const domCompletion = reconciler.refreshActions(tracked, {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      pollIntervalMs,
      signal: controller.signal,
      now,
      sleep,
      expectedActionNames: () => tracked.expectedActionNames(),
    });
    const operationalVerification = tracked
      .waitForRefreshActivation(deadline, pollIntervalMs, now, sleep, controller.signal)
      .then(async (activation) => {
        const evidence = await this.#waitForOperationalEvidence(
          activation.checkpoint,
          deadline,
          pollIntervalMs,
          now,
          sleep,
          controller.signal,
        );
        tracked.acceptOperationalEvidence(activation, evidence);
        return { activation, evidence };
      });

    try {
      const [domResult, operational] = await Promise.all([domCompletion, operationalVerification]);
      return operationalRefreshResult(
        domResult,
        operational.activation,
        operational.evidence,
        tracked.visibleActionNames(),
      );
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`CHATGPT_ACTION_CATALOG_NOT_ACTIVATED${detail}`, { cause: error });
    } finally {
      controller.abort(new Error("Authoritative action refresh completed"));
      await Promise.allSettled([domCompletion, operationalVerification]);
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  /**
   * Uses ChatGPT's own authenticated action-catalog control plane. Unlike the
   * legacy settings-card verifier this does not create a page, render the
   * plugin settings DOM, or make Chrome materialize every action card.
   */
  async verifyControlPlane(
    client: ChatGptActionCatalogControlClient,
    binding: ChatGptApprovalBinding,
    options: AuthoritativeActionRefreshOptions = {},
  ): Promise<AuthoritativeActionRefreshResult> {
    if (options.expectedDaemonPid === undefined || options.readLocalCatalogBaseline === undefined) {
      throw new Error("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED", {
        cause: new Error("MCP_CATALOG_PRE_REFRESH_BASELINE_UNAVAILABLE"),
      });
    }
    const baseline = baselineSequence(
      await options.readLocalCatalogBaseline(),
      options.expectedDaemonPid,
    );
    const receipt = await client.refresh(
      binding.appConnectorId,
      [baseline.criticalToolName],
      options.signal,
    );
    assertControlPlaneParity(receipt, baseline);
    const verifiedSchemas = receipt.actionSchemas.map((schema) => ({
      toolName: schema.toolName,
      inputProperties: schema.inputProperties,
      requiredInputProperties: schema.requiredInputProperties,
    }));
    const actionSchemaHash = createHash("sha256")
      .update(JSON.stringify(verifiedSchemas), "utf8")
      .digest("hex");
    const stateHash = createHash("sha256")
      .update(
        JSON.stringify({
          connectorId: binding.appConnectorId,
          resource: binding.mcpServerResource,
          surface: binding.mcpSurface,
          linkId: receipt.linkId,
          actionNamesSha256: receipt.actionNamesSha256,
          refreshReceiptSha256: receipt.refreshReceiptSha256,
        }),
        "utf8",
      )
      .digest("hex");
    const evidence: OperationalCatalogRefreshEvidence = {
      source: "chatgpt_control_plane_catalog",
      daemonPid: options.expectedDaemonPid,
      correlationId: binding.correlationId,
      catalogRevision: baseline.catalogRevision,
      catalogToolCount: receipt.actionCount,
      catalogPageToolCounts: [receipt.actionCount],
      catalogToolNamesSha256: receipt.actionNamesSha256,
      actionContractSha256: baseline.actionContractSha256,
      criticalToolInputSchemaSha256: baseline.criticalToolInputSchemaSha256,
      criticalToolDescriptionSha256: baseline.criticalToolDescriptionSha256,
      expectedLocalInputSchemaSha256: baseline.criticalToolInputSchemaSha256,
    };
    return {
      state: "refreshed",
      connected: true,
      fullAccess: true,
      resourceMatched: true,
      connectorMatched: true,
      stateHash,
      actionSchemaHash,
      verifiedSchemas,
      verifiedActionNames: receipt.actionNames,
      actionSnapshotEvidence: {
        source: "chatgpt_control_plane_catalog",
        state: "persisted",
        targetId: receipt.linkId,
        refreshedFromDomRevision: receipt.refreshReceiptSha256,
        persistedDomRevision: receipt.actionNamesSha256,
        visibleActionToolCount: receipt.actionCount,
        visibleActionNamesSha256: receipt.actionNamesSha256,
        verifiedActionNames: receipt.actionNames,
        completedSteps: [],
      },
      verificationSource: "chatgpt_control_plane_catalog",
      operationalEvidence: evidence,
    };
  }

  async #checkpoint(
    expectedDaemonPid: number | undefined,
    readLocalCatalogBaseline: (() => Promise<LiveLocalCatalogBaseline>) | undefined,
    now: () => Date,
  ): Promise<CatalogCheckpoint> {
    let entries: readonly OmniCodexOperationalLogEntry[] = [];
    let logCursor: OmniCodexOperationalLogCursor | undefined;
    try {
      if (this.#log.captureCursor !== undefined && this.#log.readFrom !== undefined) {
        logCursor = await this.#log.captureCursor();
      } else {
        entries = await this.#log.read();
      }
    } catch {
      // DOM schema readback can still prove the rendered critical schema when
      // operational logs are unavailable. It does not prove catalog completeness.
    }
    const knownCorrelationIds = new Set(
      entries.flatMap((entry) => {
        const correlationId = stringDetail(entry, "correlationId");
        return correlationId === undefined ? [] : [correlationId];
      }),
    );
    let expectedSequence: CatalogSequence | undefined;
    if (expectedDaemonPid !== undefined && readLocalCatalogBaseline !== undefined) {
      try {
        expectedSequence = baselineSequence(await readLocalCatalogBaseline(), expectedDaemonPid);
      } catch {
        // DOM schema readback remains independently useful for the rendered
        // critical schema. The complete-catalog path fails closed without this.
      }
    }
    return {
      capturedAt: now().toISOString(),
      knownCorrelationIds,
      ...(logCursor === undefined ? {} : { logCursor }),
      ...(expectedDaemonPid === undefined ? {} : { expectedDaemonPid }),
      ...(expectedSequence === undefined ? {} : { expectedSequence }),
    };
  }

  async #waitForOperationalEvidence(
    checkpoint: CatalogCheckpoint,
    deadline: number,
    interval: number,
    now: () => Date,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Promise<OperationalCatalogRefreshEvidence> {
    if (checkpoint.expectedDaemonPid === undefined || checkpoint.expectedSequence === undefined) {
      throw new Error("MCP_CATALOG_PRE_CLICK_BASELINE_UNAVAILABLE");
    }
    let entries: readonly OmniCodexOperationalLogEntry[] = [];
    let logCursor = checkpoint.logCursor;
    while (now().getTime() <= deadline) {
      if (signal.aborted) throw signal.reason;
      if (logCursor !== undefined && this.#log.readFrom !== undefined) {
        const batch = await this.#log.readFrom(logCursor);
        logCursor = batch.cursor;
        if (batch.entries.length > 0) entries = [...entries, ...batch.entries];
      } else {
        entries = await this.#log.read();
      }
      const evidence = postClickEvidence(entries, checkpoint);
      if (evidence !== undefined) return evidence;
      const remaining = deadline - now().getTime();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining), signal);
    }
    throw new Error("POST_CLICK_MCP_CATALOG_NOT_OBSERVED");
  }
}

class RefreshTrackingSurface implements ChatGptSettingsSurface {
  readonly #inner: ChatGptSettingsSurface;
  readonly #checkpoint: () => Promise<CatalogCheckpoint>;
  readonly #signal: AbortSignal;
  #latest?: ChatGptSettingsSnapshot;
  #activation?: RefreshActivation;
  #activationError?: unknown;
  #operationalEvidence?: OperationalCatalogRefreshEvidence;
  #snapshotTail: Promise<void> = Promise.resolve();

  constructor(
    inner: ChatGptSettingsSurface,
    checkpoint: () => Promise<CatalogCheckpoint>,
    signal: AbortSignal,
  ) {
    this.#inner = inner;
    this.#checkpoint = checkpoint;
    this.#signal = signal;
  }

  async snapshot(signal?: AbortSignal): Promise<ChatGptSettingsSnapshot> {
    const read = this.#snapshotTail.then(() =>
      this.#inner.snapshotControls === undefined
        ? this.#inner.snapshot(signal)
        : this.#inner.snapshotControls(signal),
    );
    this.#snapshotTail = read.then(
      () => undefined,
      () => undefined,
    );
    const snapshot = this.#withOperationalCatalog(await read);
    this.#latest = snapshot;
    return snapshot;
  }

  acceptOperationalEvidence(
    activation: RefreshActivation,
    evidence: OperationalCatalogRefreshEvidence,
  ): void {
    if (this.#activation !== activation) {
      throw new Error("CHATGPT_ACTION_REFRESH_ACTIVATION_CHANGED");
    }
    this.#operationalEvidence = evidence;
  }

  async activate(ref: string, expectedDomRevision: string, signal?: AbortSignal): Promise<void> {
    const latest = this.#latest;
    if (latest?.controls.refreshActions?.ref !== ref) {
      await this.#inner.activate(ref, expectedDomRevision, signal);
      return;
    }
    if (this.#activation !== undefined) throw new Error("CHATGPT_ACTION_REFRESH_ALREADY_ACTIVATED");
    const checkpoint = await this.#checkpoint();
    try {
      await this.#inner.activate(ref, expectedDomRevision, signal);
      this.#activation = {
        checkpoint,
        targetId: latest.targetId,
        beforeDomRevision: latest.domRevision,
      };
    } catch (error) {
      this.#activationError = error;
      throw error;
    }
  }

  async waitForRefreshActivation(
    deadline: number,
    interval: number,
    now: () => Date,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal: AbortSignal = this.#signal,
  ): Promise<RefreshActivation> {
    while (now().getTime() <= deadline) {
      if (this.#activation !== undefined) return this.#activation;
      if (this.#activationError !== undefined) throw this.#activationError;
      if (signal.aborted) throw signal.reason;
      const remaining = deadline - now().getTime();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining), signal);
    }
    throw new Error("CHATGPT_ACTION_REFRESH_WAS_NOT_ACTIVATED");
  }

  visibleActionNames(): readonly string[] {
    return canonicalToolNames((this.#latest?.actionCatalog ?? []).map(({ toolName }) => toolName));
  }

  expectedActionNames(): readonly string[] | undefined {
    return this.#activation?.checkpoint.expectedSequence?.toolNames;
  }

  #withOperationalCatalog(snapshot: ChatGptSettingsSnapshot): ChatGptSettingsSnapshot {
    const evidence = this.#operationalEvidence;
    const expected = this.#activation?.checkpoint.expectedSequence;
    if (evidence === undefined || expected === undefined) return snapshot;
    const criticalSchema: ChatGptSettingsSnapshot["actionSchemas"] = [
      {
        toolName: expected.criticalToolName,
        inputProperties: expected.criticalToolProperties.split(",").filter(Boolean),
        requiredInputProperties: expected.criticalToolRequired.split(",").filter(Boolean),
      },
    ];
    const postClickRevision = createHash("sha256")
      .update(
        JSON.stringify([
          snapshot.domRevision,
          evidence.correlationId,
          evidence.catalogRevision,
          evidence.catalogToolNamesSha256,
        ]),
        "utf8",
      )
      .digest("hex");
    return {
      ...snapshot,
      domRevision: postClickRevision,
      actionSchemas: criticalSchema,
      actionCatalog: expected.toolNames.map((toolName) => ({
        toolName,
        description:
          toolName === "codex__omnicodex__session_identity"
            ? "Read the current OmniCodex work session identity and catalog revision."
            : toolName === "codex__functions__exec"
              ? "Execute native Codex tools from JavaScript."
              : toolName === expected.criticalToolName
                ? "Search the live native OmniCodex catalog."
                : "",
      })),
      actionToolCount: expected.toolCount,
    };
  }
}

function baselineSequence(
  baseline: LiveLocalCatalogBaseline,
  expectedDaemonPid: number,
): CatalogSequence {
  if (
    baseline.daemonPid !== expectedDaemonPid ||
    !isSha256(baseline.catalogRevision) ||
    baseline.chatGptActionToolCount < 1 ||
    baseline.chatGptActionToolNames.length !== baseline.chatGptActionToolCount ||
    new Set(baseline.chatGptActionToolNames).size !== baseline.chatGptActionToolNames.length ||
    !sameStrings(
      baseline.chatGptActionToolNames,
      canonicalToolNames(baseline.chatGptActionToolNames),
    ) ||
    !isSha256(baseline.chatGptActionToolNamesSha256) ||
    baseline.chatGptActionToolNamesSha256 !== toolNamesSha256(baseline.chatGptActionToolNames) ||
    !isSha256(baseline.chatGptActionContractSha256) ||
    baseline.chatGptCriticalToolName !== CRITICAL_TOOL_NAME ||
    !baseline.chatGptActionToolNames.includes(baseline.chatGptCriticalToolName) ||
    !containsCriticalProperties(baseline.chatGptCriticalToolProperties) ||
    baseline.chatGptCriticalToolRequired !== CRITICAL_REQUIRED.join(",") ||
    !isSha256(baseline.chatGptCriticalToolDescriptionSha256) ||
    !isSha256(baseline.chatGptCriticalToolInputSchemaSha256)
  ) {
    throw new Error("LIVE_LOCAL_CATALOG_BASELINE_INVALID");
  }
  return {
    catalogRevision: baseline.catalogRevision,
    toolCount: baseline.chatGptActionToolCount,
    toolNames: [...baseline.chatGptActionToolNames],
    toolNamesSha256: baseline.chatGptActionToolNamesSha256,
    actionContractSha256: baseline.chatGptActionContractSha256,
    criticalToolName: baseline.chatGptCriticalToolName,
    criticalToolProperties: baseline.chatGptCriticalToolProperties,
    criticalToolRequired: baseline.chatGptCriticalToolRequired,
    criticalToolDescriptionSha256: baseline.chatGptCriticalToolDescriptionSha256,
    criticalToolInputSchemaSha256: baseline.chatGptCriticalToolInputSchemaSha256,
  };
}

function containsCriticalProperties(value: string): boolean {
  const properties = new Set(
    value
      .split(",")
      .map((property) => property.trim())
      .filter((property) => property.length > 0),
  );
  return CRITICAL_PROPERTIES.every((property) => properties.has(property));
}

function postClickEvidence(
  entries: readonly OmniCodexOperationalLogEntry[],
  checkpoint: CatalogCheckpoint,
): OperationalCatalogRefreshEvidence | undefined {
  const pid = checkpoint.expectedDaemonPid;
  const expected = checkpoint.expectedSequence;
  if (pid === undefined || expected === undefined) return undefined;
  const postClick = entries.filter(
    (entry) => entry.pid === pid && entry.timestamp >= checkpoint.capturedAt,
  );
  const firstPages = postClick.filter(
    (entry) =>
      entry.event === "mcp_tool_catalog_observed" &&
      booleanDetail(entry, "cursorPresent") === false &&
      stringDetail(entry, "catalogRevision") === expected.catalogRevision,
  );
  for (const firstPage of firstPages) {
    const correlationId = stringDetail(firstPage, "correlationId");
    if (correlationId === undefined || checkpoint.knownCorrelationIds.has(correlationId)) continue;
    const initialized = postClick.some(
      (entry) =>
        entry.event === "mcp_request_observed" &&
        stringDetail(entry, "correlationId") === correlationId &&
        stringDetail(entry, "surface") === "full" &&
        stringDetail(entry, "rpcMethod") === "initialize" &&
        booleanDetail(entry, "sessionHeaderPresent") === false &&
        numberDetail(entry, "status") === 200 &&
        stringDetail(entry, "outcome") === "new_session_transport",
    );
    const listCompleted = postClick.some(
      (entry) =>
        entry.event === "mcp_request_observed" &&
        stringDetail(entry, "correlationId") === correlationId &&
        stringDetail(entry, "surface") === "full" &&
        stringDetail(entry, "rpcMethod") === "tools/list" &&
        numberDetail(entry, "status") === 200,
    );
    if (!initialized || !listCompleted) continue;
    const sequence = catalogEntries(postClick, firstPage, pid, correlationId);
    if (!isCompleteCatalogSequence(sequence, expected.catalogRevision, expected.toolCount))
      continue;
    const criticalPages = sequence.filter(
      (entry) => numberDetail(entry, "criticalToolCount") === 1,
    );
    const criticalPage = criticalPages[0];
    if (
      criticalPages.length !== 1 ||
      criticalPage === undefined ||
      !exactCriticalShape(criticalPage, expected) ||
      stringDetail(criticalPage, "criticalToolDescriptionSha256") !==
        expected.criticalToolDescriptionSha256 ||
      stringDetail(criticalPage, "criticalToolInputSchemaSha256") !==
        expected.criticalToolInputSchemaSha256
    ) {
      continue;
    }
    const pageToolCounts = sequence.map((entry) => numberDetail(entry, "toolCount") ?? 0);
    return {
      source: "post_click_mcp_catalog",
      daemonPid: pid,
      correlationId,
      catalogRevision: expected.catalogRevision,
      catalogToolCount: pageToolCounts.reduce((sum, count) => sum + count, 0),
      catalogPageToolCounts: pageToolCounts,
      catalogToolNamesSha256: expected.toolNamesSha256,
      actionContractSha256: expected.actionContractSha256,
      criticalToolInputSchemaSha256: expected.criticalToolInputSchemaSha256,
      criticalToolDescriptionSha256: expected.criticalToolDescriptionSha256,
      expectedLocalInputSchemaSha256: expected.criticalToolInputSchemaSha256,
    };
  }
  return undefined;
}

function catalogEntries(
  entries: readonly OmniCodexOperationalLogEntry[],
  first: OmniCodexOperationalLogEntry,
  pid: number,
  correlationId: string,
): readonly OmniCodexOperationalLogEntry[] {
  const firstIndex = entries.indexOf(first);
  if (firstIndex < 0) return [];
  return entries
    .slice(firstIndex)
    .filter(
      (entry) =>
        entry.pid === pid &&
        entry.event === "mcp_tool_catalog_observed" &&
        stringDetail(entry, "correlationId") === correlationId,
    );
}

function isCompleteCatalogSequence(
  entries: readonly OmniCodexOperationalLogEntry[],
  catalogRevision: string,
  expectedToolCount: number,
): boolean {
  if (entries.length < 1) return false;
  let observedToolCount = 0;
  for (const [index, entry] of entries.entries()) {
    const count = numberDetail(entry, "toolCount");
    if (
      count === undefined ||
      !Number.isInteger(count) ||
      count < 1 ||
      stringDetail(entry, "surface") !== "full" ||
      stringDetail(entry, "catalogRevision") !== catalogRevision ||
      booleanDetail(entry, "cursorPresent") !== index > 0 ||
      booleanDetail(entry, "nextCursorPresent") !== index < entries.length - 1 ||
      !isValidCriticalToolCount(numberDetail(entry, "criticalToolCount"))
    ) {
      return false;
    }
    observedToolCount += count;
  }
  return (
    observedToolCount === expectedToolCount &&
    entries.reduce((sum, entry) => sum + (numberDetail(entry, "criticalToolCount") ?? 0), 0) === 1
  );
}

function isValidCriticalToolCount(value: number | undefined): boolean {
  return value === 0 || value === 1;
}

function exactCriticalShape(
  entry: OmniCodexOperationalLogEntry,
  expected?: CatalogSequence,
): boolean {
  return (
    stringDetail(entry, "surface") === "full" &&
    stringDetail(entry, "criticalToolProperties") ===
      (expected?.criticalToolProperties ?? CRITICAL_PROPERTIES.join(",")) &&
    stringDetail(entry, "criticalToolRequired") ===
      (expected?.criticalToolRequired ?? CRITICAL_REQUIRED.join(","))
  );
}

function operationalRefreshResult(
  domResult: SettingsActionRefreshResult,
  activation: RefreshActivation,
  evidence: OperationalCatalogRefreshEvidence,
  visibleActionNames: readonly string[],
): AuthoritativeActionRefreshResult {
  const expected = activation.checkpoint.expectedSequence;
  if (expected === undefined) throw new Error("MCP_CATALOG_PRE_CLICK_BASELINE_UNAVAILABLE");
  const uiEvidence = domResult.actionSnapshotEvidence;
  if (
    uiEvidence.source !== "chatgpt_ui" ||
    uiEvidence.state !== "persisted" ||
    uiEvidence.targetId !== activation.targetId ||
    uiEvidence.refreshedFromDomRevision !== activation.beforeDomRevision
  ) {
    throw new Error("CHATGPT_ACTION_SNAPSHOT_EVIDENCE_INVALID");
  }
  const canonicalVisibleNames = canonicalToolNames(visibleActionNames);
  const expectedNames = expected.toolNames;
  const visibleNameSet = new Set(canonicalVisibleNames);
  const expectedNameSet = new Set(expectedNames);
  const missingActionNames = expectedNames.filter((name) => !visibleNameSet.has(name));
  const unexpectedActionNames = canonicalVisibleNames.filter((name) => !expectedNameSet.has(name));
  const visibleActionNamesSha256 = toolNamesSha256(canonicalVisibleNames);
  if (
    uiEvidence.visibleActionToolCount !== canonicalVisibleNames.length ||
    uiEvidence.visibleActionNamesSha256 !== visibleActionNamesSha256 ||
    canonicalVisibleNames.length !== expectedNames.length ||
    missingActionNames.length > 0 ||
    unexpectedActionNames.length > 0 ||
    visibleActionNamesSha256 !== expected.toolNamesSha256
  ) {
    throw new Error(
      `CHATGPT_ACTION_CATALOG_NAME_PARITY_FAILED ${JSON.stringify({
        expectedCount: expectedNames.length,
        visibleCount: canonicalVisibleNames.length,
        expectedNamesSha256: expected.toolNamesSha256,
        visibleNamesSha256: visibleActionNamesSha256,
        missingActionNames,
        unexpectedActionNames,
      })}`,
    );
  }
  return {
    ...domResult,
    actionSnapshotEvidence: {
      ...uiEvidence,
      source: "post_click_mcp_catalog",
      visibleActionToolCount: evidence.catalogToolCount,
      visibleActionNamesSha256: evidence.catalogToolNamesSha256,
    },
    verificationSource: "post_click_mcp_catalog",
    operationalEvidence: evidence,
  };
}

function assertControlPlaneParity(
  receipt: ChatGptActionCatalogControlReceipt,
  expected: CatalogSequence,
): void {
  const expectedNames = expected.toolNames;
  const visibleNames = canonicalToolNames(receipt.actionNames);
  const visibleSet = new Set(visibleNames);
  const expectedSet = new Set(expectedNames);
  const missingActionNames = expectedNames.filter((name) => !visibleSet.has(name));
  const unexpectedActionNames = visibleNames.filter((name) => !expectedSet.has(name));
  const criticalSchemas = receipt.actionSchemas.filter(
    (schema) => schema.toolName === expected.criticalToolName,
  );
  const critical = criticalSchemas[0];
  if (
    receipt.actionCount !== visibleNames.length ||
    receipt.actionNamesSha256 !== toolNamesSha256(visibleNames) ||
    visibleNames.length !== expectedNames.length ||
    missingActionNames.length > 0 ||
    unexpectedActionNames.length > 0 ||
    receipt.actionNamesSha256 !== expected.toolNamesSha256 ||
    criticalSchemas.length !== 1 ||
    critical === undefined ||
    critical.inputProperties.join(",") !== expected.criticalToolProperties ||
    critical.requiredInputProperties.join(",") !== expected.criticalToolRequired
  ) {
    throw new Error(
      `CHATGPT_ACTION_CATALOG_CONTROL_PLANE_PARITY_FAILED ${JSON.stringify({
        expectedCount: expectedNames.length,
        visibleCount: visibleNames.length,
        expectedNamesSha256: expected.toolNamesSha256,
        visibleNamesSha256: receipt.actionNamesSha256,
        missingActionNames,
        unexpectedActionNames,
        criticalSchemaCount: criticalSchemas.length,
        criticalProperties: critical?.inputProperties ?? [],
        criticalRequired: critical?.requiredInputProperties ?? [],
      })}`,
    );
  }
}

function canonicalToolNames(names: readonly string[]): readonly string[] {
  return [...new Set(names)].sort((left, right) => left.localeCompare(right, "en"));
}

function toolNamesSha256(names: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(names), "utf8").digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringDetail(
  entry: OmniCodexOperationalLogEntry | undefined,
  key: string,
): string | undefined {
  const value = entry?.details?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberDetail(
  entry: OmniCodexOperationalLogEntry | undefined,
  key: string,
): number | undefined {
  const value = entry?.details?.[key];
  return typeof value === "number" ? value : undefined;
}

function booleanDetail(
  entry: OmniCodexOperationalLogEntry | undefined,
  key: string,
): boolean | undefined {
  const value = entry?.details?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function isSha256(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{64}$/u.test(value);
}

function boundedDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
