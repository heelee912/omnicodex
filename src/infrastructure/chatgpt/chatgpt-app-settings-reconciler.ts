import { createHash } from "node:crypto";
import type {
  ChatGptApprovalBinding,
  ConsentActionReceipt,
  SelectorClass,
} from "./chatgpt-app-approval-adapter.js";
import type {
  ActivatedOwnedSettingsSession,
  BoundedCdpSession,
  ChatGptLoopbackCdpTransport,
  OwnedSettingsTargetLocation,
} from "./chatgpt-cdp-transport.js";
import {
  CHATGPT_APP_SETTINGS_URL,
  CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION,
  CHATGPT_SETTINGS_CONTROL_CLICK_FUNCTION,
  CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION,
  CHATGPT_SETTINGS_DOCUMENT_EXPRESSION,
  callFunctionAndReleaseObject,
  chatGptAppSettingsUrl,
  isOwnedPageActivationPending,
} from "./chatgpt-cdp-transport.js";

export interface ChatGptSettingsControl {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly checked?: boolean;
  readonly selectorClass: SelectorClass;
}

/**
 * One tool input schema read back from the official ChatGPT app-detail action
 * catalog. Property names remain attached to their exact tool name so a word
 * shown by another action cannot satisfy critical-schema verification.
 */
export interface ChatGptActionSchemaReadback {
  readonly toolName: string;
  readonly inputProperties: readonly string[];
  readonly requiredInputProperties: readonly string[];
}

/** One exact action card and its rendered selection description. */
export interface ChatGptActionCatalogReadback {
  readonly toolName: string;
  readonly description: string;
}

export type ChatGptActionSnapshotStep =
  | "review"
  | "update"
  | "apply"
  | "save"
  | "enable"
  | "confirm"
  | "commit_version";

export interface ChatGptActionSnapshotControl extends ChatGptSettingsControl {
  readonly step: ChatGptActionSnapshotStep;
}

/**
 * Settings-side proof that the refreshed action snapshot reached a stable
 * post-commit readback. This is deliberately separate from MCP `tools/list`
 * evidence: one proves what ChatGPT persisted, the other proves what the
 * server advertised.
 */
export interface ChatGptActionSnapshotEvidence {
  /**
   * The ordinary settings reconciler can read a small rendered catalog. The
   * production refresh verifier instead uses the complete post-click MCP
   * traversal so ChatGPT is never forced to render hundreds of action cards
   * merely to prove a catalog it has already fetched.
   */
  readonly source: "chatgpt_ui" | "post_click_mcp_catalog" | "chatgpt_control_plane_catalog";
  readonly state: "persisted";
  readonly targetId: string;
  readonly refreshedFromDomRevision: string;
  readonly persistedDomRevision: string;
  readonly visibleActionToolCount: number;
  /** Stable digest of the canonically sorted visible action-name set. */
  readonly visibleActionNamesSha256: string;
  readonly verifiedActionNames: readonly string[];
  readonly completedSteps: readonly ChatGptActionSnapshotStep[];
  readonly versionId?: string;
}

export interface ChatGptSettingsSnapshot {
  readonly targetId: string;
  readonly route: string;
  readonly domRevision: string;
  readonly exactAppVisible: boolean;
  readonly detailVisible: boolean;
  readonly connectorMatched: boolean;
  readonly resourceMatched: boolean;
  readonly connected: boolean;
  readonly fullAccess: boolean;
  /** A safe, DOM-free observation while the exact owned target navigates or completes OAuth. */
  readonly transition?:
    | "owned_navigation_pending"
    | "oauth_authorization"
    | "chatgpt_oauth_callback"
    | "chatgpt_settings_return";
  /**
   * Schemas currently rendered by the official app-detail action catalog.
   * This is a narrow UI readback, not proof that every catalog page rendered.
   */
  readonly actionSchemas?: readonly ChatGptActionSchemaReadback[];
  /** Exact action names and descriptions rendered in the current app-detail snapshot. */
  readonly actionCatalog?: readonly ChatGptActionCatalogReadback[];
  /** Count of distinct action names rendered in this DOM snapshot. */
  readonly actionToolCount?: number;
  /** Exact version ID rendered by the canonical app detail, when present. */
  readonly actionVersionId?: string;
  /** The owned ChatGPT settings target is showing account sign-in, not app settings. */
  readonly loginRequired?: boolean;
  readonly controls: {
    readonly appEntry?: ChatGptSettingsControl;
    readonly connect?: ChatGptSettingsControl;
    readonly confirmConnect?: ChatGptSettingsControl;
    readonly permissions?: ChatGptSettingsControl;
    readonly fullAccess?: ChatGptSettingsControl;
    readonly refreshActions?: ChatGptSettingsControl;
    /** The one unambiguous next step in ChatGPT's action-snapshot commit flow. */
    readonly actionSnapshotAdvance?: ChatGptActionSnapshotControl;
  };
}

export interface ChatGptSettingsSurface {
  snapshot(signal?: AbortSignal): Promise<ChatGptSettingsSnapshot>;
  /**
   * Optional bounded settings read for control-plane automation. It excludes
   * the virtualized action catalog while retaining the exact target,
   * connection, permission, and actionable controls.
   */
  snapshotControls?(signal?: AbortSignal): Promise<ChatGptSettingsSnapshot>;
  activate(ref: string, expectedDomRevision: string, signal?: AbortSignal): Promise<void>;
}

export interface SettingsReconcileOptions {
  readonly dryRun?: boolean;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly pendingConnectAttempt?: SettingsConnectAttempt;
  readonly onConnectAttempt?: (attempt: SettingsConnectAttempt) => Promise<void>;
}

export interface SettingsConnectAttempt {
  readonly timestamp: string;
  readonly correlationId: string;
  readonly selectorClass: SelectorClass;
  readonly beforeStateHash: string;
  readonly clickStateHash: string;
}

export interface SettingsReconcileResult {
  readonly state: "dry_run" | "reused" | "reconciled";
  readonly connected: boolean;
  readonly fullAccess: boolean;
  readonly resourceMatched: boolean;
  readonly connectorMatched: boolean;
  /** Hash-only proof of the final exact settings state. This is not a click receipt. */
  readonly stateHash: string;
  readonly receipts: readonly ConsentActionReceipt[];
}

export interface CriticalToolSchemaExpectation {
  readonly toolName: string;
  readonly inputProperties: readonly string[];
  readonly requiredInputProperties: readonly string[];
}

export interface SettingsActionRefreshOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Defaults to OmniCodex's representative direct native-execution tool schema. */
  readonly criticalSchemas?: readonly CriticalToolSchemaExpectation[];
  /**
   * Optional authoritative catalog expectation resolved immediately after the
   * Refresh click. When supplied, an unchanged but stale ChatGPT snapshot is
   * never accepted merely because representative schemas are still present.
   */
  readonly expectedActionNames?: () => readonly string[] | undefined;
}

export interface SettingsActionRefreshResult {
  readonly state: "refreshed";
  readonly connected: true;
  readonly fullAccess: true;
  readonly resourceMatched: true;
  readonly connectorMatched: true;
  /** Hash-only proof of the exact settings state after Refresh. */
  readonly stateHash: string;
  /** Hash of only the rendered critical tool/property pairs verified after Refresh. */
  readonly actionSchemaHash: string;
  readonly verifiedSchemas: readonly ChatGptActionSchemaReadback[];
  /** Direct actions proved present in the post-click ChatGPT action snapshot. */
  readonly verifiedActionNames: readonly string[];
  /** Persisted ChatGPT snapshot readback, independent of server catalog evidence. */
  readonly actionSnapshotEvidence: ChatGptActionSnapshotEvidence;
}

export const OMNICODEX_CRITICAL_ACTION_SCHEMAS: readonly CriticalToolSchemaExpectation[] = [
  {
    toolName: "call_native_tool",
    inputProperties: [
      "arguments",
      "expectedCatalogRevision",
      "input",
      "name",
      "ordering",
      "payload",
      "query",
      "timeoutMs",
      "toolId",
    ],
    requiredInputProperties: [],
  },
];

export const OMNICODEX_REQUIRED_ACTION_NAMES = [
  "call_native_tool",
  "app_server_rpc",
  "codex_app__list_threads",
  "codex_app__read_thread",
  "codex__app_server__fs_readFile",
  "codex__app_server__fs_writeFile",
  "codex__app_server__command_exec",
] as const;

const SESSION_IDENTITY_DESCRIPTION =
  "Read the current OmniCodex work session identity and catalog revision.";
const ACTION_CARD_UI_LABELS = new Set([
  "action",
  "actions",
  "description",
  "input",
  "input schema",
  "metadata",
  "output",
  "output schema",
  "parameters",
  "schema",
  "tool",
  "tools",
  "도구",
  "도구들",
  "메타데이터",
  "설명",
  "스키마",
  "액션",
  "액션들",
  "입력",
  "입력 스키마",
  "출력",
  "출력 스키마",
]);
const ACTION_CARD_DESCRIPTION_DECORATIONS = new Set([
  ...ACTION_CARD_UI_LABELS,
  "public",
  "publicly",
  "read",
  "read only",
  "read-only",
  "write",
  "open world",
  "destructive",
  "recommended",
  "output schema recommended",
  "metadata display state",
  "visibility",
  "공개",
  "공개적으로",
  "읽기",
  "읽기 전용",
  "쓰기",
  "오픈 월드",
  "파괴적",
  "권장",
  "출력 스키마 권장",
  "메타데이터 표시 상태",
  "표시 상태",
]);

const CONNECT = new Set(["connect", "연결", "connect connect", "연결 연결"]);
const CONFIRM_CONNECT = new Set(["connect app", "연결하기", "confirm connection"]);
const DISCONNECT = new Set(["disconnect", "연결 해제"]);
const PERMISSIONS = ["permissions", "권한"];
const FULL_ACCESS = ["allow all actions", "allow all", "모든 액션 허용", "모두 허용"];
const REFRESH_ACTIONS = new Set(["refresh", "새로 고침"]);
const ACTION_SNAPSHOT_STEP_LABELS: Readonly<
  Record<ChatGptActionSnapshotStep, ReadonlySet<string>>
> = {
  review: new Set([
    "review",
    "review actions",
    "review changes",
    "검토",
    "액션 검토",
    "변경사항 검토",
  ]),
  update: new Set([
    "update",
    "update actions",
    "update app",
    "업데이트",
    "액션 업데이트",
    "앱 업데이트",
  ]),
  apply: new Set(["apply", "apply changes", "적용", "변경사항 적용"]),
  save: new Set(["save", "save changes", "저장", "변경사항 저장"]),
  enable: new Set([
    "enable",
    "enable actions",
    "enable all",
    "enable all actions",
    "사용 설정",
    "액션 활성화",
    "모두 활성화",
    "모든 액션 활성화",
  ]),
  confirm: new Set(["confirm", "confirm changes", "확인", "변경사항 확인"]),
  commit_version: new Set([
    "commit version",
    "create new version",
    "create version",
    "save version",
    "update version",
    "버전 만들기",
    "버전 생성",
    "버전 저장",
    "버전 업데이트",
    "버전 커밋",
  ]),
};
const CLICKABLE = new Set(["button", "link", "menuitem", "radio", "option"]);
const CHATGPT_LOGIN = new Set(["log in", "sign in", "로그인"]);
const APP_ENTRY_STATUS_SUFFIXES = [
  "allow all actions",
  "allow all",
  "모든 액션 허용",
  "모두 허용",
  "allow low-risk actions",
  "저위험 액션 허용",
  "저위험 허용",
  "read only",
  "읽기 전용",
  "reconnect",
  "다시 연결",
  "connected",
  "연결됨",
];

/**
 * Reconciles the exact app in ChatGPT settings before an Oracle prompt is
 * submitted. Receipts are emitted only for controls that were actually clicked
 * and whose postcondition was read back from the same run-owned target.
 */
export class ChatGptAppSettingsReconciler {
  readonly #binding: ChatGptApprovalBinding;
  constructor(binding: ChatGptApprovalBinding) {
    for (const [key, value] of Object.entries(binding)) {
      if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
    }
    this.#binding = { ...binding };
  }

  async reconcile(
    surface: ChatGptSettingsSurface,
    options: SettingsReconcileOptions = {},
  ): Promise<SettingsReconcileResult> {
    const timeout = explicitTimeout(options.timeoutMs);
    const interval = options.pollIntervalMs ?? 250;
    if (interval < 10) throw new Error("Invalid settings reconcile bounds");
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? boundedDelay;
    const deadline = timeout === undefined ? Number.POSITIVE_INFINITY : now().getTime() + timeout;
    const receipts: ConsentActionReceipt[] = [];

    let current = await this.#waitFor(
      surface,
      (snapshot) =>
        snapshot.controls.appEntry !== undefined ||
        (snapshot.exactAppVisible &&
          snapshot.detailVisible &&
          snapshot.connectorMatched &&
          snapshot.resourceMatched),
      deadline,
      interval,
      now,
      sleep,
      options.signal,
      "CHATGPT_APP_NOT_VISIBLE",
    );
    if (options.dryRun === true) return result("dry_run", this.#binding, current, receipts);

    current = await this.#ensureDetail(
      surface,
      current,
      deadline,
      interval,
      now,
      sleep,
      options.signal,
    );
    this.#assertExactDetail(current);
    const exactResourceTargetId = current.targetId;

    if (current.connected && options.pendingConnectAttempt !== undefined) {
      const pending = options.pendingConnectAttempt;
      if (pending.correlationId !== this.#binding.correlationId) {
        throw new Error("CHATGPT_PENDING_CONNECT_BINDING_MISMATCH");
      }
      receipts.push({
        ...this.#binding,
        timestamp: now().toISOString(),
        action: "connect",
        consentStrength: "connection",
        evidenceSource: "settings_reconcile",
        selectorClass: pending.selectorClass,
        beforeStateHash: pending.beforeStateHash,
        afterStateHash: settingsStateHash(this.#binding, current),
      });
    }

    if (!current.connected) {
      const before = current;
      const connect = requireControl(current.controls.connect, "CHATGPT_CONNECT_CONTROL_MISSING");
      await surface.activate(connect.ref, current.domRevision, options.signal);
      current = await this.#waitFor(
        surface,
        (snapshot) =>
          snapshot.domRevision !== before.domRevision &&
          (snapshot.controls.confirmConnect !== undefined ||
            snapshot.connected ||
            snapshot.controls.appEntry !== undefined),
        deadline,
        interval,
        now,
        sleep,
        options.signal,
        "CHATGPT_CONNECT_MUTATION_NOT_OBSERVED",
      );
      if (current.controls.confirmConnect !== undefined) {
        const modal = current;
        const confirmConnect = current.controls.confirmConnect;
        await surface.activate(confirmConnect.ref, current.domRevision, options.signal);
        await options.onConnectAttempt?.({
          timestamp: now().toISOString(),
          correlationId: this.#binding.correlationId,
          selectorClass: confirmConnect.selectorClass,
          beforeStateHash: settingsStateHash(this.#binding, before),
          clickStateHash: settingsStateHash(this.#binding, modal),
        });
        current = await this.#waitFor(
          surface,
          (snapshot) =>
            snapshot.domRevision !== modal.domRevision &&
            (snapshot.connected || snapshot.controls.appEntry !== undefined),
          deadline,
          interval,
          now,
          sleep,
          options.signal,
          "CHATGPT_CONNECT_CONFIRMATION_NOT_OBSERVED",
        );
      }
      current = await this.#ensureDetail(
        surface,
        current,
        deadline,
        interval,
        now,
        sleep,
        options.signal,
      );
      if (!current.connected) throw new Error("CHATGPT_CONNECTION_STATE_NOT_CONFIRMED");
      receipts.push(this.#receipt("connect", "connection", before, current, connect, now));
    }

    if (!current.fullAccess) {
      const before = current;
      if (current.controls.fullAccess === undefined) {
        const permissions = requireControl(
          current.controls.permissions,
          "CHATGPT_PERMISSION_ENTRY_MISSING",
        );
        await surface.activate(permissions.ref, current.domRevision, options.signal);
        const opened = current;
        current = await this.#waitFor(
          surface,
          (snapshot) =>
            snapshot.domRevision !== opened.domRevision &&
            snapshot.controls.fullAccess !== undefined,
          deadline,
          interval,
          now,
          sleep,
          options.signal,
          "CHATGPT_FULL_ACCESS_CONTROL_MISSING",
        );
      }
      const maximum = requireControl(
        current.controls.fullAccess,
        "CHATGPT_FULL_ACCESS_CONTROL_MISSING",
      );
      if (maximum.checked !== true) {
        const selection = current;
        await surface.activate(maximum.ref, current.domRevision, options.signal);
        current = await this.#waitFor(
          surface,
          (snapshot) => snapshot.domRevision !== selection.domRevision && snapshot.fullAccess,
          deadline,
          interval,
          now,
          sleep,
          options.signal,
          "CHATGPT_FULL_ACCESS_STATE_NOT_CONFIRMED",
        );
      }
      if (!current.fullAccess) throw new Error("CHATGPT_FULL_ACCESS_STATE_NOT_CONFIRMED");
      receipts.push(this.#receipt("always_allow", "full_access", before, current, maximum, now));
    }

    this.#assertExactConnector(current);
    if (current.targetId !== exactResourceTargetId) {
      throw new Error("CHATGPT_SETTINGS_TARGET_CHANGED");
    }
    if (!current.connected || !current.fullAccess) {
      throw new Error("CHATGPT_SETTINGS_POSTCONDITION_FAILED");
    }
    return result(
      receipts.length === 0 ? "reused" : "reconciled",
      this.#binding,
      { ...current, resourceMatched: true },
      receipts,
    );
  }

  /**
   * Refreshes the official action catalog of the already-connected canonical
   * app, then verifies the selected critical schemas rendered after the click.
   * A DOM snapshot cannot prove completeness of a paginated or virtualized
   * catalog; complete-catalog verification is performed by the operational
   * MCP traversal verifier.
   * This path deliberately has no Connect, Disconnect, Reconnect, permission,
   * or connector-creation fallback.
   */
  async refreshActions(
    surface: ChatGptSettingsSurface,
    options: SettingsActionRefreshOptions = {},
  ): Promise<SettingsActionRefreshResult> {
    const timeout = explicitTimeout(options.timeoutMs);
    const interval = options.pollIntervalMs ?? 250;
    if (interval < 10) throw new Error("Invalid settings refresh bounds");
    const criticalSchemas = normalizeCriticalSchemas(
      options.criticalSchemas ?? OMNICODEX_CRITICAL_ACTION_SCHEMAS,
    );
    const now = options.now ?? (() => new Date());
    const sleep = options.sleep ?? boundedDelay;
    const deadline = timeout === undefined ? Number.POSITIVE_INFINITY : now().getTime() + timeout;

    let current = await this.#waitFor(
      surface,
      (snapshot) =>
        snapshot.controls.appEntry !== undefined ||
        (snapshot.exactAppVisible &&
          snapshot.detailVisible &&
          snapshot.connectorMatched &&
          snapshot.resourceMatched),
      deadline,
      interval,
      now,
      sleep,
      options.signal,
      "CHATGPT_APP_NOT_VISIBLE",
    );
    current = await this.#ensureDetail(
      surface,
      current,
      deadline,
      interval,
      now,
      sleep,
      options.signal,
    );
    this.#assertExactDetail(current);
    if (!current.connected || !current.fullAccess) {
      throw new Error("CHATGPT_ACTION_REFRESH_REQUIRES_CONNECTED_FULL_ACCESS_APP");
    }
    const targetId = current.targetId;
    const beforeRevision = current.domRevision;
    const beforeActionSnapshotHash = actionSnapshotSemanticHash(current);
    const refresh = requireControl(
      current.controls.refreshActions,
      "CHATGPT_ACTION_REFRESH_CONTROL_MISSING",
    );

    await surface.activate(refresh.ref, beforeRevision, options.signal);
    const expectedActionNames = resolveExpectedActionNames(options.expectedActionNames);
    const completedSteps: ChatGptActionSnapshotStep[] = [];
    let lastActivationRevision = beforeRevision;
    let verified:
      | {
          readonly verifiedSchemas: readonly ChatGptActionSchemaReadback[];
          readonly verifiedActionNames: readonly string[];
        }
      | undefined;
    while (now().getTime() <= deadline) {
      options.signal?.throwIfAborted();
      current = await surface.snapshot(options.signal);
      if (current.loginRequired === true) throw new Error("CHATGPT_LOGIN_REQUIRED");
      if (current.targetId !== targetId) throw new Error("CHATGPT_SETTINGS_TARGET_CHANGED");

      if (current.domRevision !== lastActivationRevision) {
        const advance = current.controls.actionSnapshotAdvance;
        if (advance !== undefined) {
          await surface.activate(advance.ref, current.domRevision, options.signal);
          completedSteps.push(advance.step);
          lastActivationRevision = current.domRevision;
          continue;
        }
        if (
          expectedActionNames !== undefined ||
          actionSnapshotSemanticHash(current) !== beforeActionSnapshotHash
        ) {
          verified = stableActionSnapshotReadback(current, criticalSchemas, expectedActionNames);
          if (verified !== undefined) break;
        }
      }

      // Refresh is idempotent when ChatGPT already has the current action
      // version. In that case the post-click snapshot can be authoritative
      // without changing the DOM revision or exposing an additional commit
      // control.
      if (
        expectedActionNames !== undefined &&
        current.controls.actionSnapshotAdvance === undefined
      ) {
        verified = stableActionSnapshotReadback(current, criticalSchemas, expectedActionNames);
        if (verified !== undefined) break;
      }

      const remaining = deadline - now().getTime();
      if (remaining <= 0) break;
      await sleep(Math.min(interval, remaining), options.signal);
    }
    if (verified === undefined) {
      if (expectedActionNames !== undefined) {
        const parity = actionCatalogParityDiagnostics(current, expectedActionNames);
        if (parity.missingActionNames.length > 0 || parity.unexpectedActionNames.length > 0) {
          throw new Error(
            `CHATGPT_ACTION_CATALOG_NAME_PARITY_FAILED ${JSON.stringify({
              expectedCount: parity.expectedActionToolCount,
              visibleCount: parity.visibleActionToolCount,
              expectedNamesSha256: parity.expectedActionNamesSha256,
              visibleNamesSha256: parity.visibleActionNamesSha256,
              missingActionNames: parity.missingActionNames,
              unexpectedActionNames: parity.unexpectedActionNames,
            })}`,
          );
        }
      }
      const requiredNames = new Set<string>(OMNICODEX_REQUIRED_ACTION_NAMES);
      throw new Error(
        `CHATGPT_ACTION_CATALOG_NOT_ACTIVATED ${JSON.stringify({
          targetId,
          beforeRevision,
          currentRevision: current.domRevision,
          completedSteps,
          availableControls: Object.entries(current.controls)
            .map(([key, control]) => ({ key, role: control.role, name: control.name }))
            .sort((left, right) => left.key.localeCompare(right.key, "en")),
          exactAppVisible: current.exactAppVisible,
          detailVisible: current.detailVisible,
          connectorMatched: current.connectorMatched,
          resourceMatched: current.resourceMatched,
          connected: current.connected,
          fullAccess: current.fullAccess,
          actionToolCount: current.actionToolCount,
          requiredActionsSeen: (current.actionCatalog ?? [])
            .map(({ toolName }) => toolName)
            .filter((toolName) => requiredNames.has(toolName))
            .sort(),
          criticalSchemasSeen: (current.actionSchemas ?? [])
            .filter(({ toolName }) =>
              criticalSchemas.some((expectation) => expectation.toolName === toolName),
            )
            .sort((left, right) => left.toolName.localeCompare(right.toolName, "en")),
          actionVersionId: current.actionVersionId,
        })}`,
      );
    }

    this.#assertExactDetail(current);
    if (current.targetId !== targetId) throw new Error("CHATGPT_SETTINGS_TARGET_CHANGED");
    if (!current.connected || !current.fullAccess) {
      throw new Error("CHATGPT_SETTINGS_POSTCONDITION_FAILED");
    }
    const visibleActionNames = canonicalActionToolNames(current);
    const actionSnapshotEvidence: ChatGptActionSnapshotEvidence = {
      source: "chatgpt_ui",
      state: "persisted",
      targetId,
      refreshedFromDomRevision: beforeRevision,
      persistedDomRevision: current.domRevision,
      visibleActionToolCount: current.actionToolCount ?? current.actionCatalog?.length ?? 0,
      visibleActionNamesSha256: actionToolNamesSha256(visibleActionNames),
      verifiedActionNames: verified.verifiedActionNames,
      completedSteps,
      ...(current.actionVersionId === undefined ? {} : { versionId: current.actionVersionId }),
    };
    return {
      state: "refreshed",
      connected: true,
      fullAccess: true,
      resourceMatched: true,
      connectorMatched: true,
      stateHash: settingsStateHash(this.#binding, current),
      actionSchemaHash: actionSchemaHash(verified.verifiedSchemas),
      verifiedSchemas: verified.verifiedSchemas,
      verifiedActionNames: verified.verifiedActionNames,
      actionSnapshotEvidence,
    };
  }

  async #ensureDetail(
    surface: ChatGptSettingsSurface,
    initial: ChatGptSettingsSnapshot,
    deadline: number,
    interval: number,
    now: () => Date,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ChatGptSettingsSnapshot> {
    if (settingsDetailReady(initial)) return initial;
    if (!initial.detailVisible || !initial.connectorMatched) {
      const entry = requireControl(initial.controls.appEntry, "CHATGPT_APP_ENTRY_MISSING");
      await surface.activate(entry.ref, initial.domRevision, signal);
    }
    return this.#waitFor(
      surface,
      (snapshot) => settingsDetailReady(snapshot),
      deadline,
      interval,
      now,
      sleep,
      signal,
      "CHATGPT_APP_DETAIL_NOT_READY",
    );
  }

  #assertExactDetail(snapshot: ChatGptSettingsSnapshot): void {
    this.#assertExactConnector(snapshot);
    if (!snapshot.resourceMatched) throw new Error("CHATGPT_RESOURCE_MISMATCH");
  }

  #assertExactConnector(snapshot: ChatGptSettingsSnapshot): void {
    if (!snapshot.connectorMatched) throw new Error("CHATGPT_CONNECTOR_ID_MISMATCH");
  }

  #receipt(
    action: "connect" | "always_allow",
    strength: "connection" | "full_access",
    before: ChatGptSettingsSnapshot,
    after: ChatGptSettingsSnapshot,
    control: ChatGptSettingsControl,
    now: () => Date,
  ): ConsentActionReceipt {
    return {
      ...this.#binding,
      timestamp: now().toISOString(),
      action,
      consentStrength: strength,
      evidenceSource: "settings_reconcile",
      selectorClass: control.selectorClass,
      beforeStateHash: settingsStateHash(this.#binding, before),
      afterStateHash: settingsStateHash(this.#binding, after),
    };
  }

  async #waitFor(
    surface: ChatGptSettingsSurface,
    predicate: (snapshot: ChatGptSettingsSnapshot) => boolean,
    deadline: number,
    interval: number,
    now: () => Date,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
    signal: AbortSignal | undefined,
    error: string,
  ): Promise<ChatGptSettingsSnapshot> {
    while (now().getTime() <= deadline) {
      signal?.throwIfAborted();
      const snapshot =
        surface.snapshotControls === undefined
          ? await surface.snapshot(signal)
          : await surface.snapshotControls(signal);
      if (snapshot.loginRequired === true) throw new Error("CHATGPT_LOGIN_REQUIRED");
      if (predicate(snapshot)) return snapshot;
      await sleep(interval, signal);
    }
    throw new Error(error);
  }
}

function settingsDetailReady(snapshot: ChatGptSettingsSnapshot): boolean {
  if (!snapshot.detailVisible || !snapshot.connectorMatched || !snapshot.resourceMatched) {
    return false;
  }
  return (
    snapshot.connected ||
    snapshot.controls.connect !== undefined ||
    snapshot.controls.confirmConnect !== undefined ||
    snapshot.controls.permissions !== undefined ||
    snapshot.controls.fullAccess !== undefined ||
    snapshot.controls.refreshActions !== undefined
  );
}

/** CDP-backed settings surface bound to one exact run-owned target. */
export class CdpChatGptSettingsSurface implements ChatGptSettingsSurface {
  readonly #transport: ChatGptLoopbackCdpTransport;
  #session: BoundedCdpSession;
  readonly #binding: ChatGptApprovalBinding;
  readonly #reconnectSession:
    | ((signal?: AbortSignal) => Promise<ActivatedOwnedSettingsSession>)
    | undefined;
  #initialNavigationHistory: unknown | undefined;
  readonly #refs = new Map<
    string,
    {
      readonly backendNodeId?: number;
      readonly nodeId?: number;
      readonly runtimeRef?: string;
    }
  >();
  #revision = "";

  constructor(
    transport: ChatGptLoopbackCdpTransport,
    session: BoundedCdpSession,
    binding: ChatGptApprovalBinding,
    initialNavigationHistory?: unknown,
    reconnectSession?: (signal?: AbortSignal) => Promise<ActivatedOwnedSettingsSession>,
  ) {
    this.#transport = transport;
    this.#session = session;
    this.#binding = { ...binding };
    this.#initialNavigationHistory = initialNavigationHistory;
    this.#reconnectSession = reconnectSession;
  }

  closeSession(): void {
    this.#session.close();
  }

  async snapshot(signal?: AbortSignal): Promise<ChatGptSettingsSnapshot> {
    const location = await this.#transport.getOwnedSettingsTarget(this.#session.targetId, signal);
    if (location.kind !== "chatgpt_settings") return this.#transitionSnapshot(location);
    const target = location.target;
    if (
      !target.url.toLocaleLowerCase().includes(this.#binding.appConnectorId.toLocaleLowerCase())
    ) {
      return this.#pluginsIndexSnapshot(target, signal);
    }
    await this.#session.command("Accessibility.enable", {}, signal);
    const result = (await this.#session.command("Accessibility.getFullAXTree", {}, signal)) as {
      nodes?: unknown;
    };
    if (!Array.isArray(result.nodes)) throw new Error("CDP accessibility tree invalid");

    this.#refs.clear();
    const records: AxRecord[] = [];
    for (const raw of result.nodes) {
      const record = parseAxRecord(raw);
      if (record === undefined) continue;
      records.push(record);
      if (record.backendDOMNodeId !== undefined) {
        this.#refs.set(record.ref, { backendNodeId: record.backendDOMNodeId });
      }
    }
    const byId = new Map(records.map((record) => [record.ref, record]));
    const axAppEntry = uniqueControl(
      records,
      (record) =>
        isClickable(record) &&
        (isExactAppEntryName(record.name, this.#binding.appName) ||
          subtreeContainsExact(record.ref, byId, normalized(this.#binding.appName))),
      "CHATGPT_APP_ENTRY_AMBIGUOUS",
    );
    // The Plugins index already exposes the exact app as an accessible control.
    // Reading the full ChatGPT DOM and issuing repeated XPath searches there is
    // both unnecessary and disproportionately expensive on accounts with long
    // conversation sidebars. Only inspect HTML after entering the exact app
    // detail (whose route is connector-bound), or when AX did not expose an app
    // entry and the bounded DOM fallback is genuinely needed.
    const detailRoute = target.url
      .toLocaleLowerCase()
      .includes(this.#binding.appConnectorId.toLocaleLowerCase());
    const dom =
      axAppEntry !== undefined && !detailRoute
        ? { body: "", controls: [] as readonly DomControlRecord[] }
        : await this.#domEvidence(signal);
    const axLabels = new Set(records.map((record) => normalized(record.name)));
    const domRecords = dom.controls.filter((record) => !axLabels.has(normalized(record.name)));
    for (const record of domRecords) this.#refs.set(record.ref, { nodeId: record.nodeId });
    const allRecords = [...records, ...domRecords];
    const text = records.flatMap((record) => [record.name, record.value ?? ""]);
    const connectorMatched =
      target.url.includes(this.#binding.appConnectorId) ||
      text.some((value) => value.includes(this.#binding.appConnectorId)) ||
      dom.body.includes(this.#binding.appConnectorId);
    const resourceMatched =
      text.some((value) => value.includes(this.#binding.mcpServerResource)) ||
      dom.body.includes(this.#binding.mcpServerResource);
    const appEntry =
      axAppEntry ??
      uniqueControl(
        domRecords,
        (record) => isClickable(record) && isExactAppEntryName(record.name, this.#binding.appName),
        "CHATGPT_APP_ENTRY_AMBIGUOUS",
      );
    const connect = uniqueControl(
      allRecords,
      (record) => isClickable(record) && CONNECT.has(normalized(record.name)),
      "CHATGPT_CONNECT_CONTROL_AMBIGUOUS",
    );
    const confirmConnect = uniqueControl(
      allRecords,
      (record) =>
        isClickable(record) &&
        (CONFIRM_CONNECT.has(normalized(record.name)) ||
          isExactAccountLogin(record.name, this.#binding.appName)),
      "CHATGPT_CONNECT_CONFIRM_AMBIGUOUS",
    );
    const disconnect = uniqueControl(
      allRecords,
      (record) => isClickable(record) && DISCONNECT.has(normalized(record.name)),
      "CHATGPT_DISCONNECT_CONTROL_AMBIGUOUS",
    );
    const permissions = uniqueControl(
      allRecords,
      (record) => isClickable(record) && startsWithAny(record.name, PERMISSIONS),
      "CHATGPT_PERMISSION_ENTRY_AMBIGUOUS",
    );
    const maximum = uniqueControl(
      allRecords,
      (record) => isClickable(record) && startsWithAny(record.name, FULL_ACCESS),
      "CHATGPT_FULL_ACCESS_CONTROL_AMBIGUOUS",
    );
    const refreshActions = uniqueControl(
      allRecords,
      (record) => isClickable(record) && REFRESH_ACTIONS.has(normalized(record.name)),
      "CHATGPT_ACTION_REFRESH_CONTROL_AMBIGUOUS",
    );
    const actionSnapshotAdvance = actionSnapshotControl(allRecords);
    const actionCatalog = readActionCatalog(dom.body);
    const actionVersionId = readActionVersionId(dom.body);
    const summaryFullAccess =
      permissions !== undefined && startsWithAny(permissions.name, [...PERMISSIONS, ...FULL_ACCESS])
        ? containsAny(permissions.name, FULL_ACCESS)
        : false;
    const detailVisible =
      connectorMatched ||
      connect !== undefined ||
      confirmConnect !== undefined ||
      disconnect !== undefined ||
      maximum !== undefined;
    const connected =
      detailVisible &&
      connect === undefined &&
      confirmConnect === undefined &&
      (disconnect !== undefined || permissions !== undefined || maximum !== undefined);
    const fullAccess = maximum?.checked === true || summaryFullAccess;
    const exactAppVisible =
      appEntry !== undefined ||
      text.some((value) => normalized(value) === normalized(this.#binding.appName)) ||
      connectorMatched;
    const loginRequired = allRecords.some(
      (record) => isClickable(record) && CHATGPT_LOGIN.has(normalized(record.name)),
    );
    const controls = {
      ...(appEntry === undefined ? {} : { appEntry }),
      ...(connect === undefined ? {} : { connect }),
      ...(confirmConnect === undefined ? {} : { confirmConnect }),
      ...(permissions === undefined ? {} : { permissions }),
      ...(maximum === undefined ? {} : { fullAccess: maximum }),
      ...(refreshActions === undefined ? {} : { refreshActions }),
      ...(actionSnapshotAdvance === undefined ? {} : { actionSnapshotAdvance }),
    };
    const safe = {
      targetId: target.id,
      route: target.url,
      records: allRecords.map(({ role, name, value, checked }) => ({
        role,
        name,
        value,
        checked,
      })),
      actionCatalog: actionCatalog.actions,
      actionSchemas: actionCatalog.schemas,
      actionToolCount: actionCatalog.toolCount,
      actionVersionId,
    };
    this.#revision = createHash("sha256").update(JSON.stringify(safe)).digest("hex");
    return {
      targetId: target.id,
      route: target.url,
      domRevision: this.#revision,
      exactAppVisible,
      detailVisible,
      connectorMatched,
      resourceMatched,
      connected,
      fullAccess,
      actionSchemas: actionCatalog.schemas,
      actionCatalog: actionCatalog.actions,
      actionToolCount: actionCatalog.toolCount,
      ...(actionVersionId === undefined ? {} : { actionVersionId }),
      loginRequired,
      controls,
    };
  }

  /** Navigate only this run-owned utility target to the exact plugin detail. */
  async ensureSettingsIndex(signal?: AbortSignal): Promise<void> {
    let indexNavigationStarted = false;
    let detailNavigationStarted = false;
    for (;;) {
      signal?.throwIfAborted();
      const location = await this.#ownedSettingsLocation(signal);
      if (
        location.kind === "owned_navigation_pending" ||
        location.kind === "chatgpt_settings_return"
      ) {
        if (!indexNavigationStarted && !detailNavigationStarted) {
          await this.#session.command("Page.navigate", { url: CHATGPT_APP_SETTINGS_URL }, signal);
          indexNavigationStarted = true;
        }
        await boundedDelay(250, signal);
        continue;
      }
      if (location.kind !== "chatgpt_settings") return;
      if (
        !location.target.url
          .toLocaleLowerCase()
          .includes(this.#binding.appConnectorId.toLocaleLowerCase())
      ) {
        // Page.navigate acknowledges the request before the visible target URL
        // changes. Reissuing it on a slow renderer cancels its own navigation.
        if (detailNavigationStarted) {
          await boundedDelay(250, signal);
          continue;
        }
        const index = await this.#pluginsIndexSnapshot(location.target, signal);
        if (index.loginRequired === true) throw new Error("CHATGPT_LOGIN_REQUIRED");
        // The installed connector identity is already authoritative. The
        // current plugin directory virtualizes and filters owner-created app
        // cards, so waiting for its card can stall forever even though the
        // exact detail route is valid. Loading the directory once establishes
        // the signed-in SPA, then navigate this same owned target directly.
        await this.#session.command(
          "Page.navigate",
          { url: chatGptAppSettingsUrl(this.#binding.appConnectorId) },
          signal,
        );
        detailNavigationStarted = true;
        await boundedDelay(250, signal);
        continue;
      }
      // A cold navigation with a settings hash can complete without firing
      // ChatGPT's SPA modal transition. Once the exact connector route is live,
      // remove and restore that same hash on this owned target so the detail
      // modal opens deterministically.
      await this.#session.command(
        "Runtime.evaluate",
        {
          expression: CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION,
          returnByValue: true,
          awaitPromise: false,
        },
        signal,
      );
      return;
    }
  }

  async snapshotControls(signal?: AbortSignal): Promise<ChatGptSettingsSnapshot> {
    const location = await this.#ownedSettingsLocation(signal);
    if (location.kind !== "chatgpt_settings") return this.#transitionSnapshot(location);
    const target = location.target;
    if (
      !target.url.toLocaleLowerCase().includes(this.#binding.appConnectorId.toLocaleLowerCase())
    ) {
      return this.#pluginsIndexSnapshot(target, signal);
    }

    const records = await this.#runtimeControlRecords(signal);
    const appEntry = uniqueControl(
      records,
      (record) => isClickable(record) && isExactAppEntryName(record.name, this.#binding.appName),
      "CHATGPT_APP_ENTRY_AMBIGUOUS",
    );
    const connect = uniqueControl(
      records,
      (record) => isClickable(record) && CONNECT.has(normalized(record.name)),
      "CHATGPT_CONNECT_CONTROL_AMBIGUOUS",
    );
    const confirmConnect = uniqueControl(
      records,
      (record) =>
        isClickable(record) &&
        (CONFIRM_CONNECT.has(normalized(record.name)) ||
          isExactAccountLogin(record.name, this.#binding.appName)),
      "CHATGPT_CONNECT_CONFIRM_AMBIGUOUS",
    );
    const disconnect = uniqueControl(
      records,
      (record) => isClickable(record) && DISCONNECT.has(normalized(record.name)),
      "CHATGPT_DISCONNECT_CONTROL_AMBIGUOUS",
    );
    const permissions = uniqueControl(
      records,
      (record) => isClickable(record) && startsWithAny(record.name, PERMISSIONS),
      "CHATGPT_PERMISSION_ENTRY_AMBIGUOUS",
    );
    const maximum = uniqueControl(
      records,
      (record) => isClickable(record) && startsWithAny(record.name, FULL_ACCESS),
      "CHATGPT_FULL_ACCESS_CONTROL_AMBIGUOUS",
    );
    const refreshActions = uniqueControl(
      records,
      (record) => isClickable(record) && REFRESH_ACTIONS.has(normalized(record.name)),
      "CHATGPT_ACTION_REFRESH_CONTROL_AMBIGUOUS",
    );
    const summaryFullAccess =
      permissions !== undefined && startsWithAny(permissions.name, [...PERMISSIONS, ...FULL_ACCESS])
        ? containsAny(permissions.name, FULL_ACCESS)
        : false;
    const connectorMatched = target.url
      .toLocaleLowerCase()
      .includes(this.#binding.appConnectorId.toLocaleLowerCase());
    // A connector id identifies the ChatGPT app, not its immutable MCP URL.
    // Resource migration can therefore preserve the id while leaving the app
    // pointed at an older server.  Only assert a match when the exact resource
    // is present in the bounded accessibility readback.
    const resourceMatched =
      connectorMatched &&
      records.some((record) =>
        record.href === undefined
          ? record.name === this.#binding.mcpServerResource
          : record.href === this.#binding.mcpServerResource,
      );
    const detailVisible = connectorMatched;
    const connected =
      detailVisible &&
      connect === undefined &&
      confirmConnect === undefined &&
      (disconnect !== undefined ||
        permissions !== undefined ||
        maximum !== undefined ||
        refreshActions !== undefined);
    const fullAccess = maximum?.checked === true || summaryFullAccess;
    const controls = {
      ...(appEntry === undefined ? {} : { appEntry }),
      ...(connect === undefined ? {} : { connect }),
      ...(confirmConnect === undefined ? {} : { confirmConnect }),
      ...(permissions === undefined ? {} : { permissions }),
      ...(maximum === undefined ? {} : { fullAccess: maximum }),
      ...(refreshActions === undefined ? {} : { refreshActions }),
    };
    const safe = {
      targetId: target.id,
      route: target.url,
      controls: records.map(({ role, name, checked, href }) => ({ role, name, checked, href })),
    };
    this.#revision = createHash("sha256").update(JSON.stringify(safe)).digest("hex");
    return {
      targetId: target.id,
      route: target.url,
      domRevision: this.#revision,
      exactAppVisible: true,
      detailVisible,
      connectorMatched,
      resourceMatched,
      connected,
      fullAccess,
      loginRequired: records.some(
        (record) => isClickable(record) && CHATGPT_LOGIN.has(normalized(record.name)),
      ),
      controls,
    };
  }

  #transitionSnapshot(
    location: Exclude<OwnedSettingsTargetLocation, { readonly kind: "chatgpt_settings" }>,
  ): ChatGptSettingsSnapshot {
    this.#refs.clear();
    const transition = location.kind;
    this.#revision = createHash("sha256")
      .update(JSON.stringify({ targetId: location.targetId, route: location.route, transition }))
      .digest("hex");
    return {
      targetId: location.targetId,
      route: location.route,
      domRevision: this.#revision,
      exactAppVisible: false,
      detailVisible: false,
      connectorMatched: false,
      resourceMatched: false,
      connected: false,
      fullAccess: false,
      transition,
      controls: {},
    };
  }

  async #ownedSettingsLocation(signal?: AbortSignal): Promise<OwnedSettingsTargetLocation> {
    // Structural test doubles and alternate transports from older callers do
    // not own a socket-local classifier. Production's concrete transport does.
    if (typeof this.#transport.classifyOwnedSettingsLocation !== "function") {
      return this.#transport.getOwnedSettingsTarget(this.#session.targetId, signal);
    }
    const primed = this.#initialNavigationHistory;
    this.#initialNavigationHistory = undefined;
    let observed = primed;
    while (observed === undefined) {
      try {
        observed = await this.#session.command("Page.getNavigationHistory", {}, signal);
      } catch (error) {
        if (!isOwnedPageActivationPending(error) || signal?.aborted === true) throw error;
        // Chrome can permanently detach the old renderer agent while keeping
        // the same page target alive. Reattach to that exact owned target; do
        // not recreate the page or restart OAuth. Structural callers without
        // an ownership-preserving reconnect hook must surface the failure.
        if (this.#reconnectSession === undefined) throw error;
        const previous = this.#session;
        const reconnected = await this.#reconnectSession(signal);
        this.#session = reconnected.session;
        previous.close();
        observed = reconnected.initialNavigationHistory;
      }
    }
    const history = observed as {
      currentIndex?: unknown;
      entries?: Array<{ url?: unknown }>;
    };
    if (
      !Number.isSafeInteger(history.currentIndex) ||
      !Array.isArray(history.entries) ||
      Number(history.currentIndex) < 0 ||
      Number(history.currentIndex) >= history.entries.length
    ) {
      throw new Error("CDP owned settings navigation history invalid");
    }
    const currentUrl = history.entries[Number(history.currentIndex)]?.url;
    if (typeof currentUrl !== "string") {
      throw new Error("CDP owned settings current URL invalid");
    }
    return this.#transport.classifyOwnedSettingsLocation(this.#session.targetId, currentUrl);
  }

  async #runtimeDocumentObjectId(signal?: AbortSignal): Promise<string> {
    const result = (await this.#session.command(
      "Runtime.evaluate",
      {
        expression: CHATGPT_SETTINGS_DOCUMENT_EXPRESSION,
        returnByValue: false,
        awaitPromise: false,
      },
      signal,
    )) as { result?: { objectId?: unknown } };
    if (typeof result.result?.objectId !== "string" || result.result.objectId.length === 0) {
      throw new Error("CDP settings document object invalid");
    }
    return result.result.objectId;
  }

  async #runtimeControlRecords(signal?: AbortSignal): Promise<readonly AxRecord[]> {
    const objectId = await this.#runtimeDocumentObjectId(signal);
    const result = (await callFunctionAndReleaseObject(
      this.#session,
      {
        objectId,
        functionDeclaration: CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION,
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    )) as { result?: { value?: unknown } };
    if (!Array.isArray(result.result?.value)) {
      throw new Error("CDP settings control snapshot invalid");
    }
    const records = result.result.value.flatMap((value) => {
      const record = parseRuntimeControlRecord(value);
      return record === undefined ? [] : [record];
    });
    this.#refs.clear();
    for (const record of records) this.#refs.set(record.ref, { runtimeRef: record.ref });
    return records;
  }

  async activate(ref: string, expectedDomRevision: string, signal?: AbortSignal): Promise<void> {
    if (expectedDomRevision !== this.#revision) throw new Error("STALE_DOM");
    const node = this.#refs.get(ref);
    if (node?.runtimeRef !== undefined) {
      const objectId = await this.#runtimeDocumentObjectId(signal);
      await callFunctionAndReleaseObject(
        this.#session,
        {
          objectId,
          functionDeclaration: CHATGPT_SETTINGS_CONTROL_CLICK_FUNCTION,
          arguments: [{ value: node.runtimeRef }],
          returnByValue: true,
          awaitPromise: false,
        },
        signal,
      );
      return;
    }
    if (
      node === undefined ||
      !(
        (typeof node.backendNodeId === "number" && node.backendNodeId > 0) ||
        (typeof node.nodeId === "number" && node.nodeId > 0)
      )
    )
      throw new Error("STALE_DOM_NODE");
    const resolved = (await this.#session.command("DOM.resolveNode", node, signal)) as {
      object?: { objectId?: unknown };
    };
    if (typeof resolved.object?.objectId !== "string") {
      throw new Error("DOM node resolution failed");
    }
    await callFunctionAndReleaseObject(
      this.#session,
      {
        objectId: resolved.object.objectId,
        functionDeclaration: "function(){this.click()}",
        returnByValue: true,
        awaitPromise: false,
      },
      signal,
    );
  }

  async #pluginsIndexSnapshot(
    target: { readonly id: string; readonly url: string },
    signal?: AbortSignal,
  ): Promise<ChatGptSettingsSnapshot> {
    const records = await this.#runtimeControlRecords(signal);
    const appRecord = uniqueControl(
      records,
      (record) =>
        isClickable(record) &&
        isExactRuntimeAppEntry(record, this.#binding.appName, this.#binding.appConnectorId),
      "CHATGPT_APP_ENTRY_AMBIGUOUS",
    );
    const safe = {
      targetId: target.id,
      route: target.url,
      controlSurface: "bounded_runtime",
      buttons: records.map(({ role, name, checked }) => ({ role, name, checked })),
    };
    this.#revision = createHash("sha256").update(JSON.stringify(safe)).digest("hex");
    return {
      targetId: target.id,
      route: target.url,
      domRevision: this.#revision,
      exactAppVisible: appRecord !== undefined,
      detailVisible: false,
      connectorMatched: false,
      resourceMatched: false,
      connected: false,
      fullAccess: false,
      loginRequired: records.some(
        (record) => isClickable(record) && CHATGPT_LOGIN.has(normalized(record.name)),
      ),
      controls: appRecord === undefined ? {} : { appEntry: appRecord },
    };
  }

  async #domEvidence(signal?: AbortSignal): Promise<{
    body: string;
    controls: readonly DomControlRecord[];
  }> {
    let document: { root?: { nodeId?: unknown } };
    try {
      document = (await this.#session.command(
        "DOM.getDocument",
        { depth: 1, pierce: true },
        signal,
      )) as { root?: { nodeId?: unknown } };
    } catch (error) {
      if (isStaleDomNode(error)) return { body: "", controls: [] };
      throw error;
    }
    if (typeof document.root?.nodeId !== "number") return { body: "", controls: [] };
    let bodyMatch: { nodeId?: unknown };
    try {
      bodyMatch = (await this.#session.command(
        "DOM.querySelector",
        { nodeId: document.root.nodeId, selector: "body" },
        signal,
      )) as { nodeId?: unknown };
    } catch (error) {
      if (isStaleDomNode(error)) return { body: "", controls: [] };
      throw error;
    }
    if (typeof bodyMatch.nodeId !== "number" || bodyMatch.nodeId < 1) {
      return { body: "", controls: [] };
    }
    let outer: { outerHTML?: unknown };
    try {
      outer = (await this.#session.command(
        "DOM.getOuterHTML",
        { nodeId: bodyMatch.nodeId },
        signal,
      )) as { outerHTML?: unknown };
    } catch (error) {
      if (isStaleDomNode(error)) {
        return { body: "", controls: [] };
      }
      throw error;
    }
    if (typeof outer.outerHTML !== "string") throw new Error("CDP body HTML invalid");
    const exactConnect = await this.#exactConnectControl(signal);
    const controls: DomControlRecord[] = exactConnect === undefined ? [] : [exactConnect];
    return { body: outer.outerHTML, controls };
  }

  async #exactConnectControl(signal?: AbortSignal): Promise<DomControlRecord | undefined> {
    const app = this.#binding.appName;
    const labels = [
      "Connect",
      "연결",
      "Connect Connect",
      "연결 연결",
      "Connect app",
      "연결하기",
      "Confirm connection",
      `${app} 계정으로 로그인`,
      `Sign in to ${app}`,
      `Log in to ${app}`,
      `Sign in with ${app}`,
    ];
    let match: DomControlRecord | undefined;
    for (const label of labels) {
      const searched = (await this.#session.command(
        "DOM.performSearch",
        {
          query: `//button[normalize-space(.)=${xpathLiteral(label)}]`,
          includeUserAgentShadowDOM: true,
        },
        signal,
      )) as { searchId?: unknown; resultCount?: unknown };
      if (typeof searched.searchId !== "string" || typeof searched.resultCount !== "number") {
        throw new Error("CDP exact button search invalid");
      }
      try {
        if (searched.resultCount > 1) throw new Error("CHATGPT_ACCOUNT_LOGIN_CONTROL_AMBIGUOUS");
        if (searched.resultCount === 0) continue;
        const selected = (await this.#session.command(
          "DOM.getSearchResults",
          { searchId: searched.searchId, fromIndex: 0, toIndex: 1 },
          signal,
        )) as { nodeIds?: unknown };
        if (
          !Array.isArray(selected.nodeIds) ||
          selected.nodeIds.length !== 1 ||
          typeof selected.nodeIds[0] !== "number"
        ) {
          throw new Error("CDP exact button result invalid");
        }
        if (match !== undefined) throw new Error("CHATGPT_ACCOUNT_LOGIN_CONTROL_AMBIGUOUS");
        match = {
          ref: `dom-${selected.nodeIds[0]}`,
          nodeId: selected.nodeIds[0],
          role: "button",
          name: label,
          childIds: [],
        };
      } finally {
        await this.#session.command(
          "DOM.discardSearchResults",
          { searchId: searched.searchId },
          signal,
        );
      }
    }
    return match;
  }
}

function isStaleDomNode(error: unknown): boolean {
  return error instanceof Error && /Could not find node|No node with given id/i.test(error.message);
}

interface AxRecord {
  readonly ref: string;
  readonly backendDOMNodeId?: number;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly href?: string;
  readonly checked?: boolean;
  readonly childIds: readonly string[];
}

interface DomControlRecord extends AxRecord {
  readonly nodeId: number;
}

function parseAxRecord(value: unknown): AxRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const node = value as {
    nodeId?: unknown;
    backendDOMNodeId?: unknown;
    childIds?: unknown;
    role?: { value?: unknown };
    name?: { value?: unknown };
    value?: { value?: unknown };
    properties?: unknown;
  };
  if (
    typeof node.nodeId !== "string" ||
    typeof node.backendDOMNodeId !== "number" ||
    node.backendDOMNodeId < 1 ||
    typeof node.role?.value !== "string" ||
    typeof node.name?.value !== "string"
  )
    return undefined;
  const checked = readChecked(node.properties);
  return {
    ref: node.nodeId,
    backendDOMNodeId: node.backendDOMNodeId,
    role: node.role.value,
    name: node.name.value,
    ...(typeof node.value?.value === "string" ? { value: node.value.value } : {}),
    ...(checked === undefined ? {} : { checked }),
    childIds: Array.isArray(node.childIds)
      ? node.childIds.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function parseRuntimeControlRecord(value: unknown): AxRecord | undefined {
  if (!isRecord(value)) return undefined;
  const { ref, role, name, checked, href } = value;
  if (
    typeof ref !== "string" ||
    !/^oc-\d+$/u.test(ref) ||
    typeof role !== "string" ||
    role.trim().length === 0 ||
    typeof name !== "string" ||
    name.trim().length === 0 ||
    (checked !== undefined && typeof checked !== "boolean") ||
    (href !== undefined && (typeof href !== "string" || href.length > 2_048))
  ) {
    return undefined;
  }
  return {
    ref,
    role,
    name,
    ...(checked === undefined ? {} : { checked }),
    ...(href === undefined ? {} : { href }),
    childIds: [],
  };
}

function readChecked(properties: unknown): boolean | undefined {
  if (!Array.isArray(properties)) return undefined;
  const item = properties.find(
    (property) =>
      typeof property === "object" &&
      property !== null &&
      (property as { name?: unknown }).name === "checked",
  ) as { value?: { value?: unknown } } | undefined;
  const value = item?.value?.value;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

function readActionCatalog(bodyHtml: string): {
  readonly schemas: readonly ChatGptActionSchemaReadback[];
  readonly actions: readonly ChatGptActionCatalogReadback[];
  readonly toolCount: number;
} {
  const byToolName = new Map<
    string,
    {
      readonly schema?: ChatGptActionSchemaReadback;
      readonly description: string;
      readonly semanticDigest: string;
    }
  >();
  const cardPattern = /<li(?:\s[^>]*)?>([\s\S]*?)<\/li\s*>/gi;
  for (const match of bodyHtml.matchAll(cardPattern)) {
    const card = match[1];
    if (card === undefined) continue;
    const openingTagEnd = match[0].indexOf(">");
    const openingTag = openingTagEnd < 0 ? match[0] : match[0].slice(0, openingTagEnd + 1);
    // ChatGPT's persistent conversation sidebar is also a <li> list and can
    // contain short labels such as "Work" that happen to satisfy MCP's opaque
    // tool-name grammar. It is navigation, never an action catalog surface.
    if (/\bdata-sidebar-item(?:\s|=|>)/iu.test(openingTag + card)) continue;
    if (/<li(?:\s|>)/i.test(card)) throw new Error("CHATGPT_ACTION_SCHEMA_NESTED_CARD");
    const toolName = readActionToolName(card);
    if (toolName === undefined) continue;
    const parsed = readInputSchemaFromCard(card);
    const description = readActionDescriptionFromCard(card, toolName);
    const semanticDigest = actionCardSemanticDigest(toolName, description, parsed);
    const existing = byToolName.get(toolName);
    if (existing !== undefined) {
      if (existing.semanticDigest === semanticDigest) continue;
      throw new Error(
        `CHATGPT_ACTION_SCHEMA_CARD_AMBIGUOUS ${JSON.stringify({
          toolName,
          existing: {
            schema: existing.schema,
            semanticDigest: existing.semanticDigest,
          },
          incoming: {
            schema: parsed,
            semanticDigest,
          },
        })}`,
      );
    }
    byToolName.set(toolName, {
      ...(parsed === undefined
        ? {}
        : {
            schema: {
              toolName,
              inputProperties: parsed.inputProperties,
              requiredInputProperties: parsed.requiredInputProperties,
            },
          }),
      description,
      semanticDigest,
    });
  }
  return {
    schemas: [...byToolName.values()].flatMap(({ schema }) =>
      schema === undefined ? [] : [schema],
    ),
    actions: [...byToolName.entries()].map(([toolName, { description }]) => ({
      toolName,
      description,
    })),
    toolCount: byToolName.size,
  };
}

function actionCardSemanticDigest(
  toolName: string,
  description: string,
  schema: ParsedInputSchema | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        toolName,
        description: normalized(description),
        schema:
          schema === undefined
            ? null
            : {
                inputProperties: schema.inputProperties,
                requiredInputProperties: schema.requiredInputProperties,
              },
      }),
    )
    .digest("hex");
}

function readActionDescriptionFromCard(cardHtml: string, toolName: string): string {
  const withoutSchemas = cardHtml.replace(/<pre(?:\s[^>]*)?>[\s\S]*?<\/pre\s*>/gi, " ");
  return htmlTextNodes(withoutSchemas)
    .filter((text) => {
      const candidate = normalized(text);
      return text.trim() !== toolName && !ACTION_CARD_DESCRIPTION_DECORATIONS.has(candidate);
    })
    .join(" ")
    .trim();
}

function readInputSchemaFromCard(cardHtml: string): ParsedInputSchema | undefined {
  const matches: ParsedInputSchema[] = [];
  const prePattern = /<pre(?:\s[^>]*)?>([\s\S]*?)<\/pre\s*>/gi;
  let previousPreEnd = 0;
  for (const match of cardHtml.matchAll(prePattern)) {
    const preIndex = match.index;
    const preBody = match[1];
    if (preIndex === undefined || preBody === undefined) continue;
    const labels = htmlTextNodes(cardHtml.slice(previousPreEnd, preIndex)).map(normalized);
    previousPreEnd = preIndex + match[0].length;
    if (!labels.some((label) => label === "입력 스키마" || label === "input schema")) continue;
    const parsed = parseInputSchema(htmlToText(preBody));
    if (parsed !== undefined) matches.push(parsed);
  }
  if (matches.length > 1) throw new Error("CHATGPT_ACTION_INPUT_SCHEMA_AMBIGUOUS");
  return matches[0];
}

function htmlTextNodes(fragment: string): readonly string[] {
  const values: string[] = [];
  const textPattern = /(?:^|>)([^<]+)(?=<|$)/g;
  for (const match of fragment.matchAll(textPattern)) {
    const text = match[1];
    if (text === undefined) continue;
    const decoded = decodeHtmlEntities(text).trim().replace(/\s+/g, " ");
    if (decoded !== "") values.push(decoded);
  }
  return values;
}

function htmlToText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""));
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: "\u00a0",
    quot: '"',
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, token: string) => {
    if (!token.startsWith("#")) return named[token.toLocaleLowerCase()] ?? entity;
    const hexadecimal = token[1]?.toLocaleLowerCase() === "x";
    const numeric = hexadecimal ? token.slice(2) : token.slice(1);
    const codePoint = Number.parseInt(numeric, hexadecimal ? 16 : 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

interface ParsedInputSchema {
  readonly inputProperties: readonly string[];
  readonly requiredInputProperties: readonly string[];
}

function parseInputSchema(value: string): ParsedInputSchema | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!isRecord(decoded)) return undefined;
  const candidates = [decoded, decoded.inputSchema, decoded.input_schema, decoded.parameters];
  const schema = candidates.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && isRecord(candidate.properties),
  );
  if (schema === undefined || !isRecord(schema.properties)) return undefined;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  return {
    inputProperties: Object.keys(schema.properties).sort(),
    requiredInputProperties: [...new Set(required)].sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpToolName(value: string): boolean {
  // MCP tool names are opaque strings. Keep the UI parser deliberately to the
  // interoperable 1-128 character recommendation without inventing a required
  // server-name separator. This admits native names such as `apply_patch`,
  // `exec_command`, `functions.exec`, and ChatGPT's namespaced renderings.
  return /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,127})$/u.test(value);
}

function readActionToolName(cardHtml: string): string | undefined {
  return htmlTextNodes(cardHtml)
    .map((text) => text.trim())
    .find((text) => isMcpToolName(text) && !ACTION_CARD_UI_LABELS.has(normalized(text)));
}

function actionSnapshotControl(
  records: readonly AxRecord[],
): ChatGptActionSnapshotControl | undefined {
  const matches = records.flatMap((record) => {
    if (!isClickable(record)) return [];
    const name = normalized(record.name);
    const step = (
      Object.entries(ACTION_SNAPSHOT_STEP_LABELS) as readonly [
        ChatGptActionSnapshotStep,
        ReadonlySet<string>,
      ][]
    ).find(([, labels]) => labels.has(name))?.[0];
    return step === undefined ? [] : [{ record, step }];
  });
  if (matches.length > 1) throw new Error("CHATGPT_ACTION_SNAPSHOT_CONTROL_AMBIGUOUS");
  const match = matches[0];
  if (match === undefined) return undefined;
  return {
    ref: match.record.ref,
    role: match.record.role,
    name: match.record.name,
    ...(match.record.checked === undefined ? {} : { checked: match.record.checked }),
    selectorClass: "accessible-role-name",
    step: match.step,
  };
}

function readActionVersionId(bodyHtml: string): string | undefined {
  const nodes = htmlTextNodes(bodyHtml);
  for (const [index, node] of nodes.entries()) {
    const label = normalized(node);
    if (label !== "version id" && label !== "버전 id") continue;
    const candidate = nodes[index + 1]?.trim();
    if (candidate !== undefined && /^asdk_app_v_[A-Za-z0-9]+$/u.test(candidate)) return candidate;
  }
  return undefined;
}

function uniqueControl(
  records: readonly AxRecord[],
  predicate: (record: AxRecord) => boolean,
  error: string,
): ChatGptSettingsControl | undefined {
  const matches = records.filter(predicate);
  if (matches.length > 1) throw new Error(error);
  const match = matches[0];
  return match === undefined
    ? undefined
    : {
        ref: match.ref,
        role: match.role,
        name: match.name,
        ...(match.checked === undefined ? {} : { checked: match.checked }),
        selectorClass: "accessible-role-name",
      };
}

function isClickable(record: AxRecord): boolean {
  return CLICKABLE.has(normalized(record.role));
}

function isExactAccountLogin(value: string, appName: string): boolean {
  const candidate = normalized(value);
  const app = normalized(appName);
  return (
    candidate === `${app} 계정으로 로그인` ||
    candidate === `sign in to ${app}` ||
    candidate === `log in to ${app}` ||
    candidate === `sign in with ${app}`
  );
}

function isExactAppEntryName(value: string, appName: string): boolean {
  const candidate = normalized(value);
  const app = normalized(appName);
  return (
    candidate === app ||
    APP_ENTRY_STATUS_SUFFIXES.some((suffix) => candidate === `${app} ${normalized(suffix)}`)
  );
}

function isExactRuntimeAppEntry(record: AxRecord, appName: string, connectorId: string): boolean {
  if (isExactAppEntryName(record.name, appName)) return true;
  if (record.href === undefined) return false;
  try {
    const href = new URL(record.href);
    const pluginSegment = `plugin_${connectorId.toLocaleLowerCase()}`;
    const candidate = normalized(record.name);
    const app = normalized(appName);
    return (
      href.protocol === "https:" &&
      href.hostname === "chatgpt.com" &&
      href.port === "" &&
      href.username === "" &&
      href.password === "" &&
      href.pathname.toLocaleLowerCase() === `/plugins/${pluginSegment}` &&
      href.search === "" &&
      href.hash === "" &&
      (candidate === app || candidate.startsWith(`${app} `))
    );
  } catch {
    return false;
  }
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value
    .split("'")
    .map((part, index) => `${index === 0 ? "" : `,"'",`}'${part}'`)
    .join("")})`;
}

function subtreeContainsExact(
  root: string,
  records: ReadonlyMap<string, AxRecord>,
  expected: string,
): boolean {
  const pending = [root];
  const seen = new Set<string>();
  while (pending.length > 0 && seen.size < 128) {
    const id = pending.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const record = records.get(id);
    if (record === undefined) continue;
    if (normalized(record.name) === expected || normalized(record.value ?? "") === expected)
      return true;
    pending.push(...record.childIds);
  }
  return false;
}

function startsWithAny(value: string, prefixes: readonly string[]): boolean {
  const candidate = normalized(value);
  return prefixes.some((prefix) => candidate.startsWith(normalized(prefix)));
}

function containsAny(value: string, candidates: readonly string[]): boolean {
  const text = normalized(value);
  return candidates.some((candidate) => text.includes(normalized(candidate)));
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function requireControl<T>(value: T | undefined, error: string): T {
  if (value === undefined) throw new Error(error);
  return value;
}

function normalizeCriticalSchemas(
  expectations: readonly CriticalToolSchemaExpectation[],
): readonly CriticalToolSchemaExpectation[] {
  if (expectations.length === 0) throw new Error("Critical action schemas are required");
  const toolNames = new Set<string>();
  return expectations.map((expectation) => {
    const toolName = expectation.toolName.trim();
    if (!isMcpToolName(toolName)) throw new Error("Invalid critical action tool name");
    if (toolNames.has(toolName)) throw new Error("Duplicate critical action tool name");
    toolNames.add(toolName);
    const inputProperties = [
      ...new Set(expectation.inputProperties.map((property) => property.trim())),
    ].filter((property) => property !== "");
    if (inputProperties.length === 0) {
      throw new Error("Critical action input properties are required");
    }
    const requiredInputProperties = [
      ...new Set(expectation.requiredInputProperties.map((property) => property.trim())),
    ].filter((property) => property !== "");
    if (requiredInputProperties.some((property) => !inputProperties.includes(property))) {
      throw new Error("Critical action required properties must belong to its input schema");
    }
    return {
      toolName,
      inputProperties: inputProperties.sort((left, right) => left.localeCompare(right, "en")),
      requiredInputProperties: requiredInputProperties.sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    };
  });
}

function criticalSchemaReadback(
  snapshot: ChatGptSettingsSnapshot,
  expectations: readonly CriticalToolSchemaExpectation[],
): readonly ChatGptActionSchemaReadback[] | undefined {
  const schemas = snapshot.actionSchemas ?? [];
  if ((snapshot.actionToolCount ?? schemas.length) < expectations.length) return undefined;
  const verified: ChatGptActionSchemaReadback[] = [];
  for (const expectation of expectations) {
    const matches = schemas.filter((schema) => schema.toolName === expectation.toolName);
    if (matches.length !== 1) return undefined;
    const schema = matches[0];
    if (
      schema === undefined ||
      !containsStrings(schema.inputProperties, expectation.inputProperties) ||
      !sameStrings(schema.requiredInputProperties, expectation.requiredInputProperties)
    ) {
      return undefined;
    }
    verified.push(schema);
  }
  return verified;
}

export function activatedActionCatalogReadback(
  snapshot: ChatGptSettingsSnapshot,
  expectations: readonly CriticalToolSchemaExpectation[] = OMNICODEX_CRITICAL_ACTION_SCHEMAS,
):
  | {
      readonly verifiedSchemas: readonly ChatGptActionSchemaReadback[];
      readonly verifiedActionNames: readonly string[];
    }
  | undefined {
  const schemas = normalizeCriticalSchemas(expectations);
  const verifiedSchemas = criticalSchemaReadback(snapshot, schemas);
  if (verifiedSchemas === undefined) return undefined;
  const actions = snapshot.actionCatalog ?? [];
  for (const schema of verifiedSchemas) {
    if (actions.filter((action) => action.toolName === schema.toolName).length !== 1) {
      return undefined;
    }
  }
  const functionsExec = actions.find((action) => action.toolName === "codex__functions__exec");
  if (functionsExec !== undefined) {
    const functionsExecDescription = normalized(functionsExec.description);
    if (functionsExecDescription.length === 0) {
      return undefined;
    }
  }
  const sessionIdentity = actions.find(
    (action) => action.toolName === "codex__omnicodex__session_identity",
  );
  if (
    sessionIdentity !== undefined &&
    normalized(sessionIdentity.description) !== normalized(SESSION_IDENTITY_DESCRIPTION)
  ) {
    return undefined;
  }
  for (const toolName of OMNICODEX_REQUIRED_ACTION_NAMES) {
    if (actions.filter((action) => action.toolName === toolName).length !== 1) {
      return undefined;
    }
  }
  const visibleRequiredNames = [...OMNICODEX_REQUIRED_ACTION_NAMES];
  const visibleRequiredNameSet = new Set<string>(visibleRequiredNames);
  const verifiedActionNames = [
    ...visibleRequiredNames,
    ...verifiedSchemas
      .map(({ toolName }) => toolName)
      .filter((toolName) => !visibleRequiredNameSet.has(toolName)),
  ];
  return {
    verifiedSchemas,
    verifiedActionNames,
  };
}

function explicitTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Settings timeoutMs must be a positive safe integer");
  }
  return value;
}

function stableActionSnapshotReadback(
  snapshot: ChatGptSettingsSnapshot,
  expectations: readonly CriticalToolSchemaExpectation[],
  expectedActionNames?: readonly string[],
):
  | {
      readonly verifiedSchemas: readonly ChatGptActionSchemaReadback[];
      readonly verifiedActionNames: readonly string[];
    }
  | undefined {
  if (
    !snapshot.exactAppVisible ||
    !snapshot.detailVisible ||
    !snapshot.connectorMatched ||
    !snapshot.resourceMatched ||
    !snapshot.connected ||
    !snapshot.fullAccess ||
    snapshot.controls.actionSnapshotAdvance !== undefined
  ) {
    return undefined;
  }
  if (
    expectedActionNames !== undefined &&
    !sameStrings(canonicalActionToolNames(snapshot), expectedActionNames)
  ) {
    return undefined;
  }
  return activatedActionCatalogReadback(snapshot, expectations);
}

function actionSnapshotSemanticHash(snapshot: ChatGptSettingsSnapshot): string {
  const actions = [...(snapshot.actionCatalog ?? [])]
    .map(({ toolName, description }) => ({ toolName, description }))
    .sort((left, right) => left.toolName.localeCompare(right.toolName, "en"));
  const schemas = [...(snapshot.actionSchemas ?? [])]
    .map(({ toolName, inputProperties, requiredInputProperties }) => ({
      toolName,
      inputProperties: [...inputProperties].sort((left, right) => left.localeCompare(right, "en")),
      requiredInputProperties: [...requiredInputProperties].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
    }))
    .sort((left, right) => left.toolName.localeCompare(right.toolName, "en"));
  return createHash("sha256")
    .update(
      JSON.stringify({
        actionVersionId: snapshot.actionVersionId ?? null,
        actionToolCount: snapshot.actionToolCount ?? null,
        actions,
        schemas,
      }),
      "utf8",
    )
    .digest("hex");
}

function resolveExpectedActionNames(
  readExpectedActionNames: (() => readonly string[] | undefined) | undefined,
): readonly string[] | undefined {
  if (readExpectedActionNames === undefined) return undefined;
  const names = readExpectedActionNames();
  if (names === undefined) throw new Error("CHATGPT_ACTION_CATALOG_EXPECTATION_UNAVAILABLE");
  if (
    names.length < 1 ||
    names.some((name) => name.trim().length < 1) ||
    new Set(names).size !== names.length
  ) {
    throw new Error("CHATGPT_ACTION_CATALOG_EXPECTATION_INVALID");
  }
  return [...names].sort((left, right) => left.localeCompare(right, "en"));
}

function actionCatalogParityDiagnostics(
  snapshot: ChatGptSettingsSnapshot,
  expectedActionNames: readonly string[],
): {
  readonly expectedActionToolCount: number;
  readonly visibleActionToolCount: number;
  readonly expectedActionNamesSha256: string;
  readonly visibleActionNamesSha256: string;
  readonly missingActionNames: readonly string[];
  readonly unexpectedActionNames: readonly string[];
} {
  const visibleActionNames = canonicalActionToolNames(snapshot);
  const visibleNameSet = new Set(visibleActionNames);
  const expectedNameSet = new Set(expectedActionNames);
  return {
    expectedActionToolCount: expectedActionNames.length,
    visibleActionToolCount: visibleActionNames.length,
    expectedActionNamesSha256: actionToolNamesSha256(expectedActionNames),
    visibleActionNamesSha256: actionToolNamesSha256(visibleActionNames),
    missingActionNames: expectedActionNames.filter((name) => !visibleNameSet.has(name)),
    unexpectedActionNames: visibleActionNames.filter((name) => !expectedNameSet.has(name)),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.localeCompare(b, "en"));
  const sortedRight = [...right].sort((a, b) => a.localeCompare(b, "en"));
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function containsStrings(actual: readonly string[], expected: readonly string[]): boolean {
  const values = new Set(actual);
  return expected.every((value) => values.has(value));
}

export function actionSchemaHash(schemas: readonly ChatGptActionSchemaReadback[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...schemas]
          .map((schema) => ({
            toolName: schema.toolName,
            inputProperties: [...schema.inputProperties].sort(),
            requiredInputProperties: [...schema.requiredInputProperties].sort(),
          }))
          .sort((left, right) => left.toolName.localeCompare(right.toolName)),
      ),
    )
    .digest("hex");
}

function canonicalActionToolNames(snapshot: ChatGptSettingsSnapshot): readonly string[] {
  return [...new Set((snapshot.actionCatalog ?? []).map(({ toolName }) => toolName))].sort(
    (left, right) => left.localeCompare(right, "en"),
  );
}

function actionToolNamesSha256(names: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(names), "utf8").digest("hex");
}

export function settingsStateHash(
  binding: ChatGptApprovalBinding,
  snapshot: ChatGptSettingsSnapshot,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        binding,
        targetId: snapshot.targetId,
        route: snapshot.route,
        domRevision: snapshot.domRevision,
        exactAppVisible: snapshot.exactAppVisible,
        detailVisible: snapshot.detailVisible,
        connectorMatched: snapshot.connectorMatched,
        resourceMatched: snapshot.resourceMatched,
        connected: snapshot.connected,
        fullAccess: snapshot.fullAccess,
        transition: snapshot.transition,
        actionSchemas: [...(snapshot.actionSchemas ?? [])]
          .map((schema) => ({
            toolName: schema.toolName,
            inputProperties: [...schema.inputProperties].sort(),
            requiredInputProperties: [...schema.requiredInputProperties].sort(),
          }))
          .sort((left, right) => left.toolName.localeCompare(right.toolName)),
        actionCatalog: [...(snapshot.actionCatalog ?? [])]
          .map((action) => ({
            toolName: action.toolName,
            description: action.description,
          }))
          .sort((left, right) => left.toolName.localeCompare(right.toolName)),
        actionToolCount: snapshot.actionToolCount,
        actionVersionId: snapshot.actionVersionId,
        loginRequired: snapshot.loginRequired === true,
      }),
    )
    .digest("hex");
}

function result(
  state: SettingsReconcileResult["state"],
  binding: ChatGptApprovalBinding,
  snapshot: ChatGptSettingsSnapshot,
  receipts: readonly ConsentActionReceipt[],
): SettingsReconcileResult {
  return {
    state,
    connected: snapshot.connected,
    fullAccess: snapshot.fullAccess,
    resourceMatched: snapshot.resourceMatched,
    connectorMatched: snapshot.connectorMatched,
    stateHash: settingsStateHash(binding, snapshot),
    receipts,
  };
}

function boundedDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("ChatGPT settings reconciliation cancelled"));
      },
      { once: true },
    );
  });
}
