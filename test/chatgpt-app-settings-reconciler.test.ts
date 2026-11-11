import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OracleAdapterService } from "../src/application/oracle-adapter-service.js";
import {
  activatedActionCatalogReadback,
  CdpChatGptSettingsSurface,
  type ChatGptActionCatalogReadback,
  type ChatGptActionSnapshotStep,
  ChatGptAppSettingsReconciler,
  type ChatGptSettingsSnapshot,
  type ChatGptSettingsSurface,
  OMNICODEX_REQUIRED_ACTION_NAMES,
} from "../src/infrastructure/chatgpt/chatgpt-app-settings-reconciler.js";
import {
  type BoundedCdpSession,
  CdpProtocolError,
  type CdpTarget,
  CHATGPT_APP_SETTINGS_URL,
  CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION,
  CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION,
  CHATGPT_SETTINGS_DOCUMENT_EXPRESSION,
  ChatGptLoopbackCdpTransport,
  chatGptAppSettingsUrl,
} from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import type { OmniCodexConfig } from "../src/infrastructure/config/omnicodex-config-store.js";

const binding = {
  appConnectorId: "asdk_app_exact",
  appName: "OmniCodex Exact",
  oracleRunId: "run-exact",
  sessionId: "session-exact",
  correlationId: "correlation-exact",
  mcpServerResource: "https://mcp.example/mcp/full",
  mcpSurface: "/mcp/full",
};

const criticalToolName = "call_native_tool";
const criticalInputProperties = [
  "arguments",
  "expectedCatalogRevision",
  "input",
  "name",
  "ordering",
  "payload",
  "query",
  "timeoutMs",
  "toolId",
] as const;
const criticalRequiredInputProperties = [] as const;
const compactFunctionsExecDescription = "Execute native Codex tools from JavaScript.";
const sessionIdentityDescription =
  "Read the current OmniCodex work session identity and catalog revision.";
const activatedActionCatalog: readonly ChatGptActionCatalogReadback[] = [
  { toolName: "call_native_tool", description: "Call one native tool." },
  { toolName: "app_server_rpc", description: "Call one App Server method." },
  {
    toolName: "codex__omnicodex__session_identity",
    description: sessionIdentityDescription,
  },
  { toolName: "codex_app__list_threads", description: "List Codex threads." },
  { toolName: "codex_app__read_thread", description: "Read one Codex thread." },
  {
    toolName: "codex__app_server__fs_readFile",
    description: "Read one workspace file.",
  },
  { toolName: "codex__app_server__fs_writeFile", description: "Write one workspace file." },
  { toolName: "codex__app_server__command_exec", description: "Run one exact command." },
  { toolName: "codex__functions__exec", description: compactFunctionsExecDescription },
];

class SettingsFlow implements ChatGptSettingsSurface {
  state = 0;
  readonly activate = vi.fn(async (ref: string, revision: string) => {
    expect(revision).toBe(`revision-${this.state}`);
    const expected = ["app", "connect", "confirm", "permissions", "full"][this.state];
    expect(ref).toBe(expected);
    this.state += 1;
  });
  async snapshot(): Promise<ChatGptSettingsSnapshot> {
    const base = {
      targetId: "owned-target",
      route:
        this.state === 0
          ? "https://chatgpt.com/#settings/Connectors"
          : `https://chatgpt.com/#settings/Connectors/plugin_${binding.appConnectorId}`,
      domRevision: `revision-${this.state}`,
      exactAppVisible: true,
      detailVisible: this.state > 0,
      connectorMatched: this.state > 0,
      resourceMatched: this.state > 0 && this.state < 4,
      connected: this.state >= 3,
      fullAccess: this.state >= 5,
    };
    if (this.state === 0)
      return {
        ...base,
        controls: {
          appEntry: control("app", "button", binding.appName),
        },
      };
    if (this.state === 1)
      return { ...base, controls: { connect: control("connect", "button", "Connect Connect") } };
    if (this.state === 2)
      return {
        ...base,
        controls: { confirmConnect: control("confirm", "button", "Connect app") },
      };
    if (this.state === 3)
      return {
        ...base,
        controls: { permissions: control("permissions", "button", "Permissions") },
      };
    return {
      ...base,
      controls: {
        fullAccess: control("full", "radio", "Allow all actions", this.state >= 5),
      },
    };
  }
}

class OAuthHandoffFlow implements ChatGptSettingsSurface {
  state = 0;
  readonly activate = vi.fn(async (ref: string) => {
    expect(ref).toBe(this.state === 0 ? "connect" : "confirm");
    this.state += 1;
  });
  async snapshot(): Promise<ChatGptSettingsSnapshot> {
    return {
      targetId: "owned-target",
      route: `https://chatgpt.com/#settings/Connectors/plugin_${binding.appConnectorId}`,
      domRevision: `handoff-${this.state}`,
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: this.state === 0,
      connected: false,
      fullAccess: false,
      controls:
        this.state === 0
          ? { connect: control("connect", "button", "Connect Connect") }
          : this.state === 1
            ? { confirmConnect: control("confirm", "button", "Connect app") }
            : {},
    };
  }
}

class ConnectedNeedsFullAccessFlow implements ChatGptSettingsSurface {
  state = 0;
  readonly activate = vi.fn(async (ref: string) => {
    expect(ref).toBe(this.state === 0 ? "permissions" : "full");
    this.state += 1;
  });
  async snapshot(): Promise<ChatGptSettingsSnapshot> {
    return {
      targetId: "owned-target",
      route: `https://chatgpt.com/#settings/Connectors/plugin_${binding.appConnectorId}`,
      domRevision: `connected-${this.state}`,
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: this.state === 0,
      connected: true,
      fullAccess: this.state >= 2,
      controls:
        this.state === 0
          ? { permissions: control("permissions", "button", "Permissions") }
          : { fullAccess: control("full", "radio", "Allow all actions", this.state >= 2) },
    };
  }
}

class ActionRefreshFlow implements ChatGptSettingsSurface {
  state = 0;
  readonly activate = vi.fn(async (ref: string, revision: string) => {
    expect(ref).toBe("refresh-actions");
    expect(revision).toBe("action-catalog-0");
    this.state = 1;
  });
  async snapshot(): Promise<ChatGptSettingsSnapshot> {
    return {
      targetId: "owned-target",
      route: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
      domRevision: `action-catalog-${this.state}`,
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: true,
      connected: true,
      fullAccess: true,
      actionSchemas: [
        {
          toolName: "codex_app__unrelated_tool",
          inputProperties: ["input"],
          requiredInputProperties: ["input"],
        },
        {
          toolName: criticalToolName,
          inputProperties: this.state === 0 ? [] : criticalInputProperties,
          requiredInputProperties: this.state === 0 ? [] : criticalRequiredInputProperties,
        },
      ],
      actionToolCount: this.state === 0 ? 0 : activatedActionCatalog.length,
      actionCatalog: this.state === 0 ? [] : activatedActionCatalog,
      controls: {
        refreshActions: control("refresh-actions", "button", "새로 고침"),
      },
    };
  }
}

const defaultActionSnapshotSteps: readonly {
  readonly step: ChatGptActionSnapshotStep;
  readonly label: string;
}[] = [
  { step: "review", label: "변경사항 검토" },
  { step: "update", label: "Update actions" },
  { step: "apply", label: "변경사항 적용" },
  { step: "save", label: "Save changes" },
  { step: "enable", label: "모두 활성화" },
  { step: "confirm", label: "Confirm changes" },
  { step: "commit_version", label: "버전 커밋" },
];

class ActionSnapshotCommitFlow implements ChatGptSettingsSurface {
  state = 0;
  readonly steps: readonly { readonly step: ChatGptActionSnapshotStep; readonly label: string }[];

  constructor(steps = defaultActionSnapshotSteps) {
    this.steps = steps;
  }
  readonly activate = vi.fn(async (ref: string, revision: string) => {
    if (this.state === 0) {
      expect(ref).toBe("refresh-actions");
    } else {
      expect(ref).toBe(`advance-${this.state}`);
    }
    expect(revision).toBe(`commit-${this.state}`);
    this.state += 1;
  });

  async snapshot(): Promise<ChatGptSettingsSnapshot> {
    const advance = this.steps[this.state - 1];
    const committed = this.state > this.steps.length;
    return {
      targetId: "owned-target",
      route: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
      domRevision: `commit-${this.state}`,
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: true,
      connected: true,
      fullAccess: true,
      actionSchemas: committed
        ? [
            {
              toolName: criticalToolName,
              inputProperties: criticalInputProperties,
              requiredInputProperties: criticalRequiredInputProperties,
            },
          ]
        : [],
      actionCatalog: committed ? activatedActionCatalog : [],
      actionToolCount: committed ? activatedActionCatalog.length : 0,
      actionVersionId: committed ? "asdk_app_v_committed123" : "asdk_app_v_original123",
      controls: {
        refreshActions: control("refresh-actions", "button", "새로 고침"),
        ...(this.state > 0 && advance !== undefined
          ? {
              actionSnapshotAdvance: {
                ...control(`advance-${this.state}`, "button", advance.label),
                step: advance.step,
              },
            }
          : {}),
      },
    };
  }
}

describe("ChatGptAppSettingsReconciler", () => {
  it("rejects an activated action snapshot when a required direct tool is missing", () => {
    const snapshot = (actionCatalog: readonly ChatGptActionCatalogReadback[]) => ({
      targetId: "owned-target",
      route: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
      domRevision: "missing-required-action",
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: true,
      connected: true,
      fullAccess: true,
      actionSchemas: [
        {
          toolName: criticalToolName,
          inputProperties: criticalInputProperties,
          requiredInputProperties: criticalRequiredInputProperties,
        },
      ],
      actionCatalog,
      actionToolCount: actionCatalog.length,
      controls: {},
    });

    expect(
      activatedActionCatalogReadback(
        snapshot(
          activatedActionCatalog.filter(
            ({ toolName }) => toolName !== "codex__app_server__fs_writeFile",
          ),
        ),
      ),
    ).toBeUndefined();
    expect(
      activatedActionCatalogReadback(
        snapshot(
          activatedActionCatalog.filter(
            ({ toolName }) => toolName !== "codex__app_server__command_exec",
          ),
        ),
      ),
    ).toBeUndefined();
  });

  it("uses the bounded control snapshot instead of the full action tree during reconciliation", async () => {
    const snapshotControls = vi.fn(
      async (): Promise<ChatGptSettingsSnapshot> => ({
        targetId: "owned-target",
        route: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
        domRevision: "bounded-controls",
        exactAppVisible: true,
        detailVisible: true,
        connectorMatched: true,
        resourceMatched: true,
        connected: true,
        fullAccess: true,
        controls: {
          permissions: control("permissions", "button", "Permissions Allow all actions"),
        },
      }),
    );
    const surface: ChatGptSettingsSurface = {
      snapshot: vi.fn(async () => {
        throw new Error("full action tree must not be read");
      }),
      snapshotControls,
      activate: vi.fn(async () => undefined),
    };

    const result = await new ChatGptAppSettingsReconciler(binding).reconcile(surface, {
      dryRun: true,
      sleep: async () => undefined,
    });

    expect(result.state).toBe("dry_run");
    expect(snapshotControls).toHaveBeenCalledTimes(1);
    expect(surface.snapshot).not.toHaveBeenCalled();
  });

  it("refreshes the existing app action catalog and verifies its critical direct-tool schema", async () => {
    const surface = new ActionRefreshFlow();
    const result = await new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
      sleep: async () => {},
    });

    expect(surface.activate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      state: "refreshed",
      connected: true,
      fullAccess: true,
      connectorMatched: true,
      resourceMatched: true,
      actionSchemaHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      verifiedSchemas: [
        {
          toolName: criticalToolName,
          inputProperties: criticalInputProperties,
          requiredInputProperties: criticalRequiredInputProperties,
        },
      ],
      verifiedActionNames: OMNICODEX_REQUIRED_ACTION_NAMES,
      actionSnapshotEvidence: {
        source: "chatgpt_ui",
        state: "persisted",
        targetId: "owned-target",
        refreshedFromDomRevision: "action-catalog-0",
        persistedDomRevision: "action-catalog-1",
        visibleActionToolCount: activatedActionCatalog.length,
        verifiedActionNames: OMNICODEX_REQUIRED_ACTION_NAMES,
        completedSteps: [],
      },
    });
  });

  it("accepts an idempotent Refresh only against the authoritative expected catalog", async () => {
    const activate = vi.fn(async () => undefined);
    const snapshot = async (): Promise<ChatGptSettingsSnapshot> => ({
      targetId: "owned-target",
      route: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
      domRevision: "already-current",
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: true,
      connected: true,
      fullAccess: true,
      actionSchemas: [
        {
          toolName: criticalToolName,
          inputProperties: criticalInputProperties,
          requiredInputProperties: criticalRequiredInputProperties,
        },
      ],
      actionCatalog: activatedActionCatalog,
      actionToolCount: activatedActionCatalog.length,
      actionVersionId: "asdk_app_v_alreadycurrent",
      controls: { refreshActions: control("refresh-actions", "button", "새로 고침") },
    });

    const result = await new ChatGptAppSettingsReconciler(binding).refreshActions(
      { snapshot, activate },
      {
        expectedActionNames: () =>
          activatedActionCatalog
            .map(({ toolName }) => toolName)
            .sort((left, right) => left.localeCompare(right, "en")),
      },
    );

    expect(activate).toHaveBeenCalledOnce();
    expect(result.actionSnapshotEvidence).toMatchObject({
      refreshedFromDomRevision: "already-current",
      persistedDomRevision: "already-current",
      visibleActionToolCount: activatedActionCatalog.length,
    });
  });

  it("does not report an unchanged stale action snapshot as refreshed", async () => {
    let nowMs = 0;
    const snapshot = async (): Promise<ChatGptSettingsSnapshot> => ({
      targetId: "owned-target",
      route: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
      domRevision: "stale",
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: true,
      connected: true,
      fullAccess: true,
      actionSchemas: [
        {
          toolName: criticalToolName,
          inputProperties: criticalInputProperties,
          requiredInputProperties: criticalRequiredInputProperties,
        },
      ],
      actionCatalog: activatedActionCatalog,
      actionToolCount: activatedActionCatalog.length,
      actionVersionId: "asdk_app_v_stale",
      controls: { refreshActions: control("refresh-actions", "button", "새로 고침") },
    });

    await expect(
      new ChatGptAppSettingsReconciler(binding).refreshActions(
        { snapshot, activate: async () => undefined },
        {
          timeoutMs: 2,
          pollIntervalMs: 10,
          now: () => new Date(nowMs++),
          sleep: async () => undefined,
        },
      ),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
  });

  it("commits each post-refresh UI step before accepting persisted action readback", async () => {
    const surface = new ActionSnapshotCommitFlow();

    const result = await new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
      sleep: async () => {},
    });

    expect(surface.activate).toHaveBeenCalledTimes(8);
    expect(result.verifiedActionNames).toEqual(OMNICODEX_REQUIRED_ACTION_NAMES);
    expect(result.actionSnapshotEvidence).toEqual({
      source: "chatgpt_ui",
      state: "persisted",
      targetId: "owned-target",
      refreshedFromDomRevision: "commit-0",
      persistedDomRevision: "commit-8",
      visibleActionToolCount: activatedActionCatalog.length,
      visibleActionNamesSha256: createHash("sha256")
        .update(
          JSON.stringify(
            activatedActionCatalog
              .map(({ toolName }) => toolName)
              .sort((a, b) => a.localeCompare(b, "en")),
          ),
          "utf8",
        )
        .digest("hex"),
      verifiedActionNames: OMNICODEX_REQUIRED_ACTION_NAMES,
      completedSteps: ["review", "update", "apply", "save", "enable", "confirm", "commit_version"],
      versionId: "asdk_app_v_committed123",
    });
  });

  it("does not impose an adapter count ceiling on the action snapshot commit sequence", async () => {
    const steps = Array.from({ length: 12 }, (_, index) => ({
      step: defaultActionSnapshotSteps[index % defaultActionSnapshotSteps.length]?.step ?? "review",
      label: `step-${index}`,
    }));
    const surface = new ActionSnapshotCommitFlow(steps);

    const result = await new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
      sleep: async () => {},
    });

    expect(surface.activate).toHaveBeenCalledTimes(13);
    expect(result.actionSnapshotEvidence.completedSteps).toEqual(steps.map(({ step }) => step));
  });

  it("continues action refresh through a bounded owned-target navigation transition", async () => {
    const surface = new ActionRefreshFlow();
    const snapshot = surface.snapshot.bind(surface);
    let transitionObserved = false;
    surface.snapshot = async () => {
      const current = await snapshot();
      if (surface.state === 1 && !transitionObserved) {
        transitionObserved = true;
        return {
          targetId: current.targetId,
          route: "about:blank",
          domRevision: "owned-navigation-pending",
          exactAppVisible: false,
          detailVisible: false,
          connectorMatched: false,
          resourceMatched: false,
          connected: false,
          fullAccess: false,
          transition: "owned_navigation_pending",
          controls: {},
        };
      }
      return current;
    };

    const result = await new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
      sleep: async () => {},
    });

    expect(transitionObserved).toBe(true);
    expect(surface.activate).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("refreshed");
    expect(result.verifiedSchemas[0]?.toolName).toBe(criticalToolName);
  });

  it("accepts the critical schema among unrelated full-catalog actions", async () => {
    const surface = new ActionRefreshFlow();
    surface.snapshot = async () => {
      const snapshot = await ActionRefreshFlow.prototype.snapshot.call(surface);
      return {
        ...snapshot,
        actionSchemas: [
          ...(snapshot.actionSchemas ?? []),
          {
            toolName: "codex_app__unrelated_tool",
            inputProperties: ["input"],
            requiredInputProperties: ["input"],
          },
        ],
      };
    };
    const result = await new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
      sleep: async () => {},
    });

    expect(result.verifiedSchemas).toEqual([
      {
        toolName: criticalToolName,
        inputProperties: criticalInputProperties,
        requiredInputProperties: criticalRequiredInputProperties,
      },
    ]);
    expect(surface.activate).toHaveBeenCalledTimes(1);
  });

  it("does not claim full activation from only one visible virtualized action card", async () => {
    const surface = new ActionRefreshFlow();
    const snapshot = surface.snapshot.bind(surface);
    surface.snapshot = async () => {
      const current = await snapshot();
      if (surface.state === 0) return current;
      return {
        ...current,
        actionSchemas: [
          {
            toolName: criticalToolName,
            inputProperties: criticalInputProperties,
            requiredInputProperties: criticalRequiredInputProperties,
          },
        ],
        actionCatalog: [
          {
            toolName: criticalToolName,
            description: compactFunctionsExecDescription,
          },
        ],
        actionToolCount: 1,
      };
    };

    surface.state = 1;
    expect(activatedActionCatalogReadback(await surface.snapshot())).toBeUndefined();
  });

  it("does not impose policy wording on a valid functions.exec description", async () => {
    const actionCatalog = activatedActionCatalog.map((action) =>
      action.toolName === "codex__functions__exec"
        ? { ...action, description: "Use this for every OmniCodex operation." }
        : action,
    );
    const surface = new ActionRefreshFlow();
    const snapshot = surface.snapshot.bind(surface);
    surface.snapshot = async () => ({ ...(await snapshot()), actionCatalog });
    const result = await new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
      timeoutMs: 20,
      pollIntervalMs: 10,
      sleep: async () => {},
    });

    expect(result).toMatchObject({ state: "refreshed" });
  });

  it("accepts a complete functions.exec description without an adapter length ceiling", async () => {
    const actionCatalog = activatedActionCatalog.map((action) =>
      action.toolName === "codex__functions__exec"
        ? { ...action, description: `${action.description} ${"x".repeat(16_384)}` }
        : action,
    );
    const surface = new ActionRefreshFlow();
    const snapshot = surface.snapshot.bind(surface);
    surface.snapshot = async () => ({ ...(await snapshot()), actionCatalog });

    await expect(
      new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
        sleep: async () => {},
      }),
    ).resolves.toMatchObject({ state: "refreshed" });
  });

  it("does not activate a session identity action with different selection semantics", async () => {
    const surface = new ActionRefreshFlow();
    const snapshot = surface.snapshot.bind(surface);
    surface.snapshot = async () => ({
      ...(await snapshot()),
      actionCatalog: activatedActionCatalog.map((action) =>
        action.toolName === "codex__omnicodex__session_identity"
          ? { ...action, description: "Manage policy and permissions for the session." }
          : action,
      ),
    });
    let nowMs = 0;

    await expect(
      new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
        timeoutMs: 20,
        pollIntervalMs: 10,
        sleep: async () => {},
        now: () => {
          nowMs += 10;
          return new Date(nowMs);
        },
      }),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
  });

  it.each([
    ["a missing input property", criticalInputProperties.slice(1), criticalRequiredInputProperties],
    ["a different required set", criticalInputProperties, ["prompt"]],
  ] as const)(
    "rejects the critical direct-tool schema with %s",
    async (_, inputProperties, required) => {
      const surface = new ActionRefreshFlow();
      const snapshot = surface.snapshot.bind(surface);
      surface.snapshot = async () => {
        const current = await snapshot();
        if (surface.state === 0) return current;
        return {
          ...current,
          actionSchemas: [
            {
              toolName: criticalToolName,
              inputProperties,
              requiredInputProperties: required,
            },
          ],
        };
      };
      let nowMs = 0;

      await expect(
        new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
          timeoutMs: 20,
          pollIntervalMs: 10,
          sleep: async () => {},
          now: () => {
            nowMs += 10;
            return new Date(nowMs);
          },
        }),
      ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
    },
  );

  it("refuses action refresh unless the canonical app is already connected with full access", async () => {
    const surface = new ActionRefreshFlow();
    const original = surface.snapshot.bind(surface);
    surface.snapshot = async () => ({ ...(await original()), connected: false });

    await expect(
      new ChatGptAppSettingsReconciler(binding).refreshActions(surface, {
        sleep: async () => {},
      }),
    ).rejects.toThrow("CHATGPT_ACTION_REFRESH_REQUIRES_CONNECTED_FULL_ACCESS_APP");
    expect(surface.activate).not.toHaveBeenCalled();
  });

  it("fails immediately when the owned settings profile requires ChatGPT login", async () => {
    const sleep = vi.fn(async () => undefined);
    const surface: ChatGptSettingsSurface = {
      snapshot: vi.fn(async () => ({
        targetId: "owned-target",
        route: "https://chatgpt.com/#settings/Connectors",
        domRevision: "logged-out",
        exactAppVisible: false,
        detailVisible: false,
        connectorMatched: false,
        resourceMatched: false,
        connected: false,
        fullAccess: false,
        loginRequired: true,
        controls: {},
      })),
      activate: vi.fn(async () => undefined),
    };

    await expect(
      new ChatGptAppSettingsReconciler(binding).reconcile(surface, {
        timeoutMs: 60_000,
        sleep,
      }),
    ).rejects.toThrow("CHATGPT_LOGIN_REQUIRED");
    expect(surface.snapshot).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses the original settings-first Connect and full-access sequence with actual receipts", async () => {
    const surface = new SettingsFlow();
    const result = await new ChatGptAppSettingsReconciler(binding).reconcile(surface, {
      sleep: async () => {},
      now: () => new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(surface.activate.mock.calls.map((call) => call[0])).toEqual([
      "app",
      "connect",
      "confirm",
      "permissions",
      "full",
    ]);
    expect(result).toMatchObject({
      state: "reconciled",
      connected: true,
      fullAccess: true,
      connectorMatched: true,
      resourceMatched: true,
    });
    expect(
      result.receipts.map(({ action, consentStrength, evidenceSource }) => ({
        action,
        consentStrength,
        evidenceSource,
      })),
    ).toEqual([
      {
        action: "connect",
        consentStrength: "connection",
        evidenceSource: "settings_reconcile",
      },
      {
        action: "always_allow",
        consentStrength: "full_access",
        evidenceSource: "settings_reconcile",
      },
    ]);
  });

  it("waits for exact detail controls instead of treating a loading shell as disconnected", async () => {
    let state = 0;
    let detailReads = 0;
    const surface: ChatGptSettingsSurface = {
      activate: vi.fn(async (ref: string) => {
        expect(ref).toBe("app");
        state = 1;
      }),
      snapshot: vi.fn(async () => {
        if (state === 0) {
          return {
            targetId: "owned-target",
            route: "https://chatgpt.com/#settings/Connectors",
            domRevision: "list",
            exactAppVisible: true,
            detailVisible: false,
            connectorMatched: false,
            resourceMatched: false,
            connected: false,
            fullAccess: false,
            controls: { appEntry: control("app", "button", binding.appName) },
          };
        }
        detailReads += 1;
        const loading = detailReads === 1;
        return {
          targetId: "owned-target",
          route: `https://chatgpt.com/#settings/Connectors/plugin_${binding.appConnectorId}`,
          domRevision: loading ? "detail-loading" : "detail-ready",
          exactAppVisible: true,
          detailVisible: true,
          connectorMatched: true,
          resourceMatched: true,
          connected: !loading,
          fullAccess: !loading,
          controls: {},
        };
      }),
    };

    const result = await new ChatGptAppSettingsReconciler(binding).reconcile(surface, {
      sleep: async () => {},
    });

    expect(surface.activate).toHaveBeenCalledTimes(1);
    expect(detailReads).toBe(2);
    expect(result).toMatchObject({ state: "reused", connected: true, fullAccess: true });
  });

  it("fails before mutation when the exact resource is not present in app detail", async () => {
    const surface = new SettingsFlow();
    const original = surface.snapshot.bind(surface);
    surface.snapshot = async () => ({ ...(await original()), resourceMatched: false });
    let nowMs = 0;
    await expect(
      new ChatGptAppSettingsReconciler(binding).reconcile(surface, {
        timeoutMs: 20,
        pollIntervalMs: 10,
        sleep: async () => {},
        now: () => {
          nowMs += 10;
          return new Date(nowMs);
        },
      }),
    ).rejects.toThrow("CHATGPT_APP_DETAIL_NOT_READY");
    expect(surface.activate.mock.calls.map((call) => call[0])).toEqual(["app"]);
  });

  it("persists settings receipts as pending and does not substitute a tool result for catalog activation", async () => {
    let config: OmniCodexConfig = {
      schemaVersion: 1,
      projectRoot: "C:\\work",
      gateway: {
        host: "127.0.0.1",
        port: 8787,
        path: "/mcp",
        fullPath: "/mcp/full",
        allowedOrigins: [],
      },
      auth: {
        issuer: "https://issuer.example/",
        audience: "https://mcp.example",
        requiredScopes: ["omnicodex:full"],
        allowedSubjects: ["owner"],
      },
      oracle: {
        enabled: true,
        connectorId: binding.appConnectorId,
        connectorName: binding.appName,
        runId: binding.oracleRunId,
        resource: binding.mcpServerResource,
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        freshLiveVerification: "pending",
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    await service.reconcile(new SettingsFlow(), true, {
      sessionId: binding.sessionId,
      correlationId: binding.correlationId,
    });
    expect(config.oracle?.freshLiveVerification).toBe("pending");
    expect(config.oracle?.lastActionCatalogVerification).toBeUndefined();
    expect(config.oracle?.lastStateVerification).toMatchObject({
      correlationId: binding.correlationId,
      connected: true,
      fullAccess: true,
      stateHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(config.oracle?.lastReceipts?.map((receipt) => receipt.evidenceSource)).toEqual([
      "settings_reconcile",
      "settings_reconcile",
    ]);
    await expect(
      service.test(
        {
          snapshot: async () => ({
            ...binding,
            domRevision: "tool-result",
            connected: true,
            alwaysAllowed: true,
            toolResultPresent: true,
            nodes: [],
          }),
          activate: async () => {
            throw new Error("no conversation control should be clicked");
          },
        },
        true,
        { sessionId: binding.sessionId, correlationId: binding.correlationId },
      ),
    ).rejects.toThrow("ORACLE_REQUIRED_CONSENT_SEQUENCE_NOT_OBSERVED");
    expect(config.oracle?.freshLiveVerification).toBe("pending");
    expect(config.oracle?.lastReceipts?.map((receipt) => receipt.action)).toEqual([
      "connect",
      "always_allow",
    ]);
  });

  it("keeps a fresh hash-only settings readback pending until the action catalog is activated", async () => {
    let config: OmniCodexConfig = {
      schemaVersion: 1,
      projectRoot: "C:\\work",
      gateway: {
        host: "127.0.0.1",
        port: 8787,
        path: "/mcp",
        fullPath: "/mcp/full",
        allowedOrigins: [],
      },
      auth: {
        issuer: "https://issuer.example/",
        audience: "https://mcp.example",
        requiredScopes: ["omnicodex:full"],
        allowedSubjects: ["owner"],
      },
      oracle: {
        enabled: true,
        connectorId: binding.appConnectorId,
        connectorName: binding.appName,
        runId: binding.oracleRunId,
        resource: binding.mcpServerResource,
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        freshLiveVerification: "pending",
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });
    const result = await service.reconcile(
      {
        snapshot: async () => ({
          targetId: "owned-settings-target",
          route: `https://chatgpt.com/#settings/Connectors/plugin_${binding.appConnectorId}`,
          domRevision: "connected-full-access",
          exactAppVisible: true,
          detailVisible: true,
          connectorMatched: true,
          resourceMatched: true,
          connected: true,
          fullAccess: true,
          controls: {},
        }),
        activate: async () => {
          throw new Error("no settings control should be clicked");
        },
      },
      true,
      { sessionId: binding.sessionId, correlationId: binding.correlationId },
    );

    expect(result).toMatchObject({ state: "reused", receipts: [] });
    expect(config.oracle?.freshLiveVerification).toBe("pending");
    expect(config.oracle?.lastActionCatalogVerification).toBeUndefined();
    expect(config.oracle?.lastStateVerification).toMatchObject({
      correlationId: binding.correlationId,
      connected: true,
      fullAccess: true,
      stateHash: result.stateHash,
    });
  });

  it("durably preserves a real Connect click across OAuth handoff and promotes it after readback", async () => {
    let config: OmniCodexConfig = {
      schemaVersion: 1,
      projectRoot: "C:\\work",
      gateway: {
        host: "127.0.0.1",
        port: 8787,
        path: "/mcp",
        fullPath: "/mcp/full",
        allowedOrigins: [],
      },
      auth: {
        issuer: "https://issuer.example/",
        audience: "https://mcp.example",
        requiredScopes: ["omnicodex:full"],
        allowedSubjects: ["owner"],
      },
      oracle: {
        enabled: true,
        connectorId: binding.appConnectorId,
        connectorName: binding.appName,
        runId: binding.oracleRunId,
        resource: binding.mcpServerResource,
        surface: "/mcp/full",
        cdpEndpoint: "http://127.0.0.1:9222",
        freshLiveVerification: "pending",
      },
    };
    const service = new OracleAdapterService({
      load: async () => structuredClone(config),
      save: async (next) => {
        config = structuredClone(next);
      },
    });

    await expect(
      service.reconcile(
        new OAuthHandoffFlow(),
        true,
        { sessionId: binding.sessionId, correlationId: binding.correlationId },
        { timeoutMs: 20, pollIntervalMs: 10 },
      ),
    ).rejects.toThrow("CHATGPT_CONNECT_CONFIRMATION_NOT_OBSERVED");
    expect(config.oracle?.pendingConnectAttempt).toMatchObject({
      correlationId: binding.correlationId,
      selectorClass: "accessible-role-name",
    });
    expect(config.oracle?.lastReceipts).toBeUndefined();

    const result = await service.reconcile(new ConnectedNeedsFullAccessFlow(), true, {
      sessionId: binding.sessionId,
      correlationId: binding.correlationId,
    });
    expect(result.receipts.map((receipt) => receipt.action)).toEqual(["connect", "always_allow"]);
    expect(config.oracle?.pendingConnectAttempt).toBeUndefined();
    expect(config.oracle?.lastReceipts?.map((receipt) => receipt.action)).toEqual([
      "connect",
      "always_allow",
    ]);
  });
});

describe("owned ChatGPT settings target lifecycle", () => {
  it("does not navigate an owned target before Chrome reports an active page", async () => {
    const failure = new CdpProtocolError("Page.getNavigationHistory", {
      code: -32000,
      message: "Not attached to an active page",
    });
    const command = vi.fn(async (_method: string) => {
      throw failure;
    });
    const surface = new CdpChatGptSettingsSurface(
      { classifyOwnedSettingsLocation: vi.fn() } as unknown as ChatGptLoopbackCdpTransport,
      { targetId: "owned", command } as unknown as BoundedCdpSession,
      binding,
    );

    await expect(surface.ensureSettingsIndex()).rejects.toBe(failure);
    expect(command.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(0);
  });

  it("does not hide other Page-domain protocol failures as activation lag", async () => {
    const failure = new CdpProtocolError("Page.getNavigationHistory", {
      code: -32000,
      message: "Session closed",
    });
    const command = vi.fn(async () => {
      throw failure;
    });
    const surface = new CdpChatGptSettingsSurface(
      {
        classifyOwnedSettingsLocation: vi.fn(),
      } as unknown as ChatGptLoopbackCdpTransport,
      { targetId: "owned", command } as unknown as BoundedCdpSession,
      binding,
    );

    await expect(surface.ensureSettingsIndex()).rejects.toBe(failure);
  });

  it("does not restart in-flight index or detail navigation while the target URL lags", async () => {
    vi.useFakeTimers();
    try {
      const pending = { kind: "owned_navigation_pending", targetId: "owned", route: "about:blank" };
      const index = {
        kind: "chatgpt_settings",
        target: { id: "owned", url: CHATGPT_APP_SETTINGS_URL },
      };
      const detail = {
        kind: "chatgpt_settings",
        target: { id: "owned", url: chatGptAppSettingsUrl(binding.appConnectorId) },
      };
      const locations = [pending, pending, index, index, pending, detail];
      const command = vi.fn(async (method: string) => {
        if (method === "Runtime.evaluate") return { result: { objectId: "document" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: [] } };
        return {};
      });
      const surface = new CdpChatGptSettingsSurface(
        {
          getOwnedSettingsTarget: vi.fn(async () => locations.shift() ?? detail),
        } as unknown as ChatGptLoopbackCdpTransport,
        { targetId: "owned", command } as unknown as BoundedCdpSession,
        binding,
      );
      const completed = surface.ensureSettingsIndex();
      await vi.runAllTimersAsync();
      await completed;
      expect(command.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(2);
      expect(locations).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { role: "link", name: "Server URL", href: binding.mcpServerResource, matched: true },
    { role: "StaticText", name: binding.mcpServerResource, matched: true },
    {
      role: "link",
      name: binding.mcpServerResource,
      href: "https://old.example/mcp/full",
      matched: false,
    },
    { role: "StaticText", name: `${binding.mcpServerResource}-old`, matched: false },
  ])("matches settings resource by its actual URL: $role $name $href", async (record) => {
    const transport = {
      getOwnedSettingsTarget: async () => ({
        kind: "chatgpt_settings",
        target: { id: "owned", type: "page", url: chatGptAppSettingsUrl(binding.appConnectorId) },
      }),
    } as unknown as ChatGptLoopbackCdpTransport;
    const records: Array<{ ref: string; role: string; name: string; href?: string }> = [
      { ref: "oc-0", ...record },
    ];
    const command = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") return { result: { objectId: "document-object" } };
      if (method === "Runtime.callFunctionOn") return { result: { value: records } };
      if (method === "Runtime.releaseObject") return {};
      throw new Error(`unexpected command: ${method}`);
    });
    const surface = new CdpChatGptSettingsSurface(
      transport,
      { targetId: "owned", command } as unknown as BoundedCdpSession,
      binding,
    );
    const snapshot = await surface.snapshotControls();
    expect(snapshot.resourceMatched).toBe(record.matched);
    if (record.href !== undefined) {
      records[0] = { ref: "oc-0", ...record, href: "https://changed.example/mcp/full" };
      const changed = await surface.snapshotControls();
      expect(changed.resourceMatched).toBe(false);
      expect(changed.domRevision).not.toBe(snapshot.domRevision);
    }
  });

  it("reads the exact app from one bounded runtime control snapshot", async () => {
    const transport = {
      getOwnedSettingsTarget: vi.fn(async () => ({
        kind: "chatgpt_settings" as const,
        target: {
          id: "owned",
          type: "page",
          url: "https://chatgpt.com/#settings/Plugins",
        },
      })),
    } as unknown as ChatGptLoopbackCdpTransport;
    const command = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "Runtime.evaluate") {
        expect(params).toMatchObject({
          expression: CHATGPT_SETTINGS_DOCUMENT_EXPRESSION,
          returnByValue: false,
        });
        return { result: { objectId: "document-object" } };
      }
      if (method === "Runtime.callFunctionOn") {
        expect(params).toMatchObject({
          objectId: "document-object",
          functionDeclaration: CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION,
          returnByValue: true,
        });
        return {
          result: {
            value: [
              {
                ref: "oc-0",
                role: "button",
                name: `${binding.appName} Allow all`,
              },
            ],
          },
        };
      }
      if (method === "Runtime.releaseObject") {
        expect(params).toEqual({ objectId: "document-object" });
        return {};
      }
      throw new Error(`full DOM inspection was not expected: ${method}`);
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

    const snapshot = await new CdpChatGptSettingsSurface(transport, session, binding).snapshot();

    expect(snapshot.controls.appEntry).toMatchObject({ name: `${binding.appName} Allow all` });
    expect(command.mock.calls.map(([method]) => method)).toEqual([
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ]);
  });

  it.each(["저위험 허용", "저위험 액션 허용", "Allow low-risk actions", "읽기 전용", "Read only"])(
    "recognizes the exact canonical app entry with the %s status suffix",
    async (suffix) => {
      const snapshot = await appIndexSnapshot(`${binding.appName} ${suffix}`);

      expect(snapshot.exactAppVisible).toBe(true);
      expect(snapshot.controls.appEntry).toMatchObject({
        role: "button",
        name: `${binding.appName} ${suffix}`,
      });
    },
  );

  it.each([
    `${binding.appName} Retiring 6a8c`,
    `${binding.appName} 저위험 허용 extra`,
    `prefix ${binding.appName} 저위험 허용`,
    `${binding.appName}-copy 저위험 허용`,
  ])("does not mistake %s for the exact canonical app entry", async (label) => {
    const snapshot = await appIndexSnapshot(label);

    expect(snapshot.exactAppVisible).toBe(false);
    expect(snapshot.controls.appEntry).toBeUndefined();
  });

  it("binds HTML-entity encoded input JSON only within the exact non-nested action card", async () => {
    const transport = {
      getOwnedSettingsTarget: vi.fn(async () => ({
        kind: "chatgpt_settings",
        target: {
          id: "owned",
          type: "page",
          url: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
        },
      })),
    } as unknown as ChatGptLoopbackCdpTransport;
    const axNode = (nodeId: string, backendDOMNodeId: number, role: string, name: string) => ({
      nodeId,
      backendDOMNodeId,
      role: { value: role },
      name: { value: name },
    });
    const encodedCriticalSchema = JSON.stringify({
      type: "object",
      properties: Object.fromEntries(criticalInputProperties.map((property) => [property, {}])),
      required: criticalRequiredInputProperties,
      additionalProperties: false,
    }).replaceAll('"', "&#34;");
    const body = `<body>
      <ul>
        <li class="list-none"><a href="/c/one" data-sidebar-item="true"><span>Godot 작업 검증</span><span>Work</span></a></li>
        <li class="list-none"><a href="/c/two" data-sidebar-item="true"><span>브라우저 구분 확인 실패</span><span>Work</span></a></li>
        <li class="tool-card">
          <div><span>codex_app__unrelated_tool</span></div>
          <p>Unrelated action</p>
          <div>입력 스키마</div>
          <pre>{&quot;type&quot;:&quot;object&quot;,&quot;properties&quot;:{&quot;model&quot;:{},&quot;thinking&quot;:{}},&quot;required&quot;:[]}</pre>
        </li>
        <li class="tool-card">
          <div><span>${criticalToolName}</span></div>
          <span>공개적으로</span><span>쓰기</span><span>오픈 월드</span><span>파괴적</span><span>출력 스키마 권장</span>
          <p>${compactFunctionsExecDescription}</p>
          <span>메타데이터</span><span>표시 상태</span>
          <div>입력 스키마</div>
          <pre>${encodedCriticalSchema}</pre>
        </li>
        <li class="tool-card"><span>codex__omnicodex__session_identity</span><span>읽기</span><p>${sessionIdentityDescription}</p><span>메타데이터 표시 상태</span></li>
        <li class="tool-card"><div>Action</div><span>apply_patch</span><p>Apply a patch</p></li>
        <li class="tool-card"><span>exec_command</span><p>Run an exact command</p></li>
        <li class="tool-card"><span>functions.exec</span><p>Orchestrate native tools</p></li>
        <li class="tool-card"><span>mcp__server__tool</span><p>Namespaced tool</p></li>
        <li class="tool-card"><span>search</span><p>Search the index</p></li>
      </ul>
      <div><span>버전 ID</span><span>asdk_app_v_committed123</span></div>
    </body>`;
    let search = 0;
    const command = vi.fn(async (method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            axNode("resource", 1, "StaticText", binding.mcpServerResource),
            axNode("refresh", 2, "button", "새로 고침"),
            axNode("permissions", 3, "button", "Permissions Allow all actions"),
            axNode("review", 4, "button", "변경사항 검토"),
          ],
        };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.getOuterHTML") return { outerHTML: body };
      if (method === "DOM.performSearch") {
        search += 1;
        return { searchId: `search-${search}`, resultCount: 0 };
      }
      if (method === "DOM.discardSearchResults") return {};
      throw new Error(`unexpected ${method}`);
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

    const snapshot = await new CdpChatGptSettingsSurface(transport, session, binding).snapshot();

    expect(snapshot.controls.refreshActions).toMatchObject({
      role: "button",
      name: "새로 고침",
    });
    expect(snapshot.actionToolCount).toBe(8);
    expect(snapshot.actionSchemas).toEqual([
      {
        toolName: "codex_app__unrelated_tool",
        inputProperties: ["model", "thinking"],
        requiredInputProperties: [],
      },
      {
        toolName: criticalToolName,
        inputProperties: criticalInputProperties,
        requiredInputProperties: criticalRequiredInputProperties,
      },
    ]);
    expect(snapshot.actionCatalog?.slice(0, 2)).toEqual([
      { toolName: "codex_app__unrelated_tool", description: "Unrelated action" },
      {
        toolName: criticalToolName,
        description: compactFunctionsExecDescription,
      },
    ]);
    expect(snapshot.actionCatalog?.[2]).toEqual({
      toolName: "codex__omnicodex__session_identity",
      description: sessionIdentityDescription,
    });
    expect(snapshot.actionCatalog?.map(({ toolName }) => toolName)).toEqual([
      "codex_app__unrelated_tool",
      criticalToolName,
      "codex__omnicodex__session_identity",
      "apply_patch",
      "exec_command",
      "functions.exec",
      "mcp__server__tool",
      "search",
    ]);
    expect(snapshot.controls.actionSnapshotAdvance).toMatchObject({
      role: "button",
      name: "변경사항 검토",
      step: "review",
    });
    expect(snapshot.actionVersionId).toBe("asdk_app_v_committed123");
  });

  it("deduplicates semantically identical copies of one action card", async () => {
    const transport = {
      getOwnedSettingsTarget: vi.fn(async () => ({
        kind: "chatgpt_settings",
        target: {
          id: "owned",
          type: "page",
          url: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
        },
      })),
    } as unknown as ChatGptLoopbackCdpTransport;
    const encodedCriticalSchema = JSON.stringify({
      type: "object",
      properties: Object.fromEntries(criticalInputProperties.map((property) => [property, {}])),
      required: criticalRequiredInputProperties,
      additionalProperties: false,
    }).replaceAll('"', "&quot;");
    const reorderedCriticalSchema = JSON.stringify({
      type: "object",
      properties: Object.fromEntries(
        [...criticalInputProperties].reverse().map((property) => [property, {}]),
      ),
      required: [...criticalRequiredInputProperties].reverse(),
      additionalProperties: false,
    }).replaceAll('"', "&quot;");
    const card = (description: string, schema: string) =>
      `<li><span>${criticalToolName}</span><p>${description}</p><div>입력 스키마</div><pre>${schema}</pre></li>`;
    let search = 0;
    const command = vi.fn(async (method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "resource",
              backendDOMNodeId: 1,
              role: { value: "StaticText" },
              name: { value: binding.mcpServerResource },
            },
          ],
        };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.getOuterHTML")
        return {
          outerHTML: `<body><ul>${card("Execute bounded native tools", encodedCriticalSchema)}${card(
            "  EXECUTE   BOUNDED NATIVE TOOLS  ",
            reorderedCriticalSchema,
          )}</ul></body>`,
        };
      if (method === "DOM.performSearch") {
        search += 1;
        return { searchId: `search-${search}`, resultCount: 0 };
      }
      if (method === "DOM.discardSearchResults") return {};
      throw new Error(`unexpected ${method}`);
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

    const snapshot = await new CdpChatGptSettingsSurface(transport, session, binding).snapshot();

    expect(snapshot.actionToolCount).toBe(1);
    expect(snapshot.actionSchemas).toEqual([
      {
        toolName: criticalToolName,
        inputProperties: criticalInputProperties,
        requiredInputProperties: criticalRequiredInputProperties,
      },
    ]);
    expect(snapshot.actionCatalog).toEqual([
      { toolName: criticalToolName, description: "Execute bounded native tools" },
    ]);
  });

  it("fails closed when repeated action cards disagree semantically", async () => {
    const transport = {
      getOwnedSettingsTarget: vi.fn(async () => ({
        kind: "chatgpt_settings",
        target: {
          id: "owned",
          type: "page",
          url: `https://chatgpt.com/#settings/Plugins/plugin_${binding.appConnectorId}`,
        },
      })),
    } as unknown as ChatGptLoopbackCdpTransport;
    const firstSchema = JSON.stringify({
      type: "object",
      properties: Object.fromEntries(criticalInputProperties.map((property) => [property, {}])),
      required: criticalRequiredInputProperties,
      additionalProperties: false,
    }).replaceAll('"', "&quot;");
    const conflictingSchema = JSON.stringify({
      type: "object",
      properties: { input: {}, unexpected: {} },
      required: ["input"],
      additionalProperties: false,
    }).replaceAll('"', "&quot;");
    const card = (schema: string) =>
      `<li><span>${criticalToolName}</span><div>입력 스키마</div><pre>${schema}</pre></li>`;
    let search = 0;
    const command = vi.fn(async (method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "resource",
              backendDOMNodeId: 1,
              role: { value: "StaticText" },
              name: { value: binding.mcpServerResource },
            },
          ],
        };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") return { nodeId: 2 };
      if (method === "DOM.getOuterHTML") {
        return {
          outerHTML: `<body><ul>${card(firstSchema)}${card(conflictingSchema)}</ul></body>`,
        };
      }
      if (method === "DOM.performSearch") {
        search += 1;
        return { searchId: `search-${search}`, resultCount: 0 };
      }
      if (method === "DOM.discardSearchResults") return {};
      throw new Error(`unexpected ${method}`);
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

    await expect(
      new CdpChatGptSettingsSurface(transport, session, binding).snapshot(),
    ).rejects.toThrow("CHATGPT_ACTION_SCHEMA_CARD_AMBIGUOUS");
  });

  it("treats a navigation-stale DOM document as a bounded retryable snapshot", async () => {
    const transport = {
      getOwnedSettingsTarget: vi.fn(async () => ({
        kind: "chatgpt_settings",
        target: {
          id: "owned",
          type: "page",
          url: `https://chatgpt.com/#settings/Connectors/plugin_${binding.appConnectorId}`,
        },
      })),
    } as unknown as ChatGptLoopbackCdpTransport;
    const command = vi.fn(async (method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "resource",
              backendDOMNodeId: 1,
              role: { value: "generic" },
              name: { value: binding.mcpServerResource },
            },
          ],
        };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        throw new Error("DOM.querySelector: Could not find node with given id");
      }
      throw new Error(`unexpected ${method}`);
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;
    const snapshot = await new CdpChatGptSettingsSurface(transport, session, binding).snapshot();
    expect(snapshot.connectorMatched).toBe(true);
    expect(snapshot.resourceMatched).toBe(true);
  });

  it("does not infer resource equality from a matching connector id", async () => {
    const transport = {
      getOwnedSettingsTarget: vi.fn(async () => ({
        kind: "chatgpt_settings",
        target: {
          id: "owned",
          type: "page",
          url: `https://chatgpt.com/#settings/Connectors/plugin_${binding.appConnectorId}`,
        },
      })),
    } as unknown as ChatGptLoopbackCdpTransport;
    const command = vi.fn(async (method: string) => {
      if (method === "Accessibility.enable") return {};
      if (method === "Accessibility.getFullAXTree") {
        return {
          nodes: [
            {
              nodeId: "resource",
              backendDOMNodeId: 1,
              role: { value: "StaticText" },
              name: { value: "https://retired.example/mcp/full" },
            },
          ],
        };
      }
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
      if (method === "DOM.querySelector") {
        throw new Error("DOM.querySelector: Could not find node with given id");
      }
      throw new Error(`unexpected ${method}`);
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

    const snapshot = await new CdpChatGptSettingsSurface(transport, session, binding).snapshot();
    expect(snapshot.connectorMatched).toBe(true);
    expect(snapshot.resourceMatched).toBe(false);
  });

  it("observes an allowed OAuth handoff without reading authorization-page DOM", async () => {
    const locations = [
      {
        kind: "owned_navigation_pending" as const,
        targetId: "owned",
        route: "about:blank",
      },
      {
        kind: "oauth_authorization" as const,
        targetId: "owned",
        route: "https://issuer.example/",
      },
      {
        kind: "chatgpt_oauth_callback" as const,
        targetId: "owned",
        route: "https://chatgpt.com/connector/oauth/",
      },
      {
        kind: "chatgpt_settings_return" as const,
        targetId: "owned",
        route: "https://chatgpt.com/",
      },
    ];
    const transport = {
      getOwnedSettingsTarget: vi.fn(async () => {
        const location = locations.shift();
        if (location === undefined) throw new Error("missing test location");
        return location;
      }),
    } as unknown as ChatGptLoopbackCdpTransport;
    const command = vi.fn(async () => {
      throw new Error("OAuth DOM must not be inspected");
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;
    const surface = new CdpChatGptSettingsSurface(transport, session, binding);

    const navigation = await surface.snapshot();
    const authorization = await surface.snapshot();
    const callback = await surface.snapshot();
    const settingsReturn = await surface.snapshot();

    expect(navigation).toMatchObject({
      targetId: "owned",
      route: "about:blank",
      transition: "owned_navigation_pending",
      controls: {},
    });
    expect(authorization).toMatchObject({
      targetId: "owned",
      route: "https://issuer.example/",
      transition: "oauth_authorization",
      controls: {},
    });
    expect(callback).toMatchObject({
      targetId: "owned",
      route: "https://chatgpt.com/connector/oauth/",
      transition: "chatgpt_oauth_callback",
      controls: {},
    });
    expect(settingsReturn).toMatchObject({
      targetId: "owned",
      route: "https://chatgpt.com/",
      transition: "chatgpt_settings_return",
      controls: {},
    });
    expect(command).not.toHaveBeenCalled();
  });

  it("navigates an owned plugins shell directly even when the virtualized app card is absent", async () => {
    const getOwnedSettingsTarget = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "chatgpt_settings" as const,
        target: {
          id: "owned",
          type: "page",
          url: "https://chatgpt.com/plugins",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
        },
      })
      .mockResolvedValueOnce({
        kind: "owned_navigation_pending" as const,
        targetId: "owned",
        route: "empty",
      })
      .mockResolvedValue({
        kind: "chatgpt_settings" as const,
        target: {
          id: "owned",
          type: "page",
          url: chatGptAppSettingsUrl(binding.appConnectorId),
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
        },
      });
    const transport = {
      getOwnedSettingsTarget,
    } as unknown as ChatGptLoopbackCdpTransport;
    const calls: Array<{ method: string; params: unknown }> = [];
    const command = vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { objectId: "document-1" } };
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: [{ ref: "oc-0", role: "button", name: "내가 만듦" }],
          },
        };
      }
      return {};
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

    await new CdpChatGptSettingsSurface(transport, session, binding).ensureSettingsIndex();

    expect(calls).toContainEqual({
      method: "Page.navigate",
      params: {
        url: chatGptAppSettingsUrl(binding.appConnectorId),
      },
    });
    expect(calls.at(-1)).toEqual({
      method: "Runtime.evaluate",
      params: {
        expression: CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      },
    });
  });

  it("navigates only its owned transient blank target to the fixed settings route", async () => {
    const getOwnedSettingsTarget = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "owned_navigation_pending" as const,
        targetId: "owned",
        route: "about:blank",
      })
      .mockResolvedValueOnce({
        kind: "chatgpt_settings" as const,
        target: {
          id: "owned",
          type: "page",
          url: CHATGPT_APP_SETTINGS_URL,
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
        },
      })
      .mockResolvedValue({
        kind: "chatgpt_settings" as const,
        target: {
          id: "owned",
          type: "page",
          url: chatGptAppSettingsUrl(binding.appConnectorId),
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
        },
      });
    const transport = {
      getOwnedSettingsTarget,
    } as unknown as ChatGptLoopbackCdpTransport;
    const command = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") return { result: { objectId: "document-1" } };
      if (method === "Runtime.callFunctionOn") {
        return {
          result: {
            value: [
              {
                ref: "oc-0",
                role: "link",
                name: `${binding.appName} Owner-only Windows Codex native tools`,
                href: `https://chatgpt.com/plugins/plugin_${binding.appConnectorId}`,
              },
            ],
          },
        };
      }
      return {};
    });
    const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

    await new CdpChatGptSettingsSurface(transport, session, binding).ensureSettingsIndex();

    expect(command).toHaveBeenNthCalledWith(
      1,
      "Page.navigate",
      { url: CHATGPT_APP_SETTINGS_URL },
      undefined,
    );
    expect(command).toHaveBeenLastCalledWith(
      "Runtime.evaluate",
      {
        expression: CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      },
      undefined,
    );
    expect(command.mock.calls.filter(([method]) => method === "Page.navigate")).toHaveLength(2);
  });

  it("uses the activation receipt once and survives a transient renderer swap", async () => {
    const markerUrl = "about:blank?omnicodex_target=39bbc917-eb36-437e-9a66-937e310ae7d2";
    const detailUrl = chatGptAppSettingsUrl(binding.appConnectorId);
    const classifyOwnedSettingsLocation = vi.fn((_targetId: string, url: string) =>
      url === markerUrl
        ? {
            kind: "owned_navigation_pending" as const,
            targetId: "owned",
            route: "about:blank?omnicodex_target",
          }
        : {
            kind: "chatgpt_settings" as const,
            target: {
              id: "owned",
              type: "page",
              url,
              webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
            },
          },
    );
    const transport = {
      classifyOwnedSettingsLocation,
    } as unknown as ChatGptLoopbackCdpTransport;
    let historyReads = 0;
    const command = vi.fn(async (method: string) => {
      if (method === "Page.navigate") return {};
      if (method === "Page.getNavigationHistory") {
        historyReads += 1;
        if (historyReads === 1) {
          throw new CdpProtocolError("Page.getNavigationHistory", {
            code: -32000,
            message: "Not attached to an active page",
          });
        }
        return { currentIndex: 0, entries: [{ url: detailUrl }] };
      }
      if (method === "Runtime.evaluate") return { result: { value: true } };
      throw new Error(`unexpected ${method}`);
    });
    const session = { targetId: "owned", command, close: vi.fn() } as unknown as BoundedCdpSession;
    const surface = new CdpChatGptSettingsSurface(
      transport,
      session,
      binding,
      {
        currentIndex: 0,
        entries: [{ url: markerUrl }],
      },
      async () => ({
        session: { targetId: "owned", command, close: vi.fn() } as unknown as BoundedCdpSession,
        initialNavigationHistory: (await command("Page.getNavigationHistory")) as {
          currentIndex: number;
          entries: Array<{ url: string }>;
        },
      }),
    );

    await surface.ensureSettingsIndex();

    expect(command.mock.calls[0]?.[0]).toBe("Page.navigate");
    expect(historyReads).toBe(2);
    expect(classifyOwnedSettingsLocation).toHaveBeenNthCalledWith(1, "owned", markerUrl);
    expect(classifyOwnedSettingsLocation).toHaveBeenNthCalledWith(2, "owned", detailUrl);
  });

  it("reattaches the exact target when navigation permanently detaches the old renderer", async () => {
    const detailUrl = chatGptAppSettingsUrl(binding.appConnectorId);
    const pending = new CdpProtocolError("Page.getNavigationHistory", {
      code: -32000,
      message: "Not attached to an active page",
    });
    const oldClose = vi.fn();
    const oldCommand = vi.fn(async () => {
      throw pending;
    });
    const replacementCommand = vi.fn(async (method: string) => {
      if (method === "Runtime.evaluate") return { result: { value: true } };
      throw new Error(`unexpected ${method}`);
    });
    const replacementSession = {
      targetId: "owned",
      command: replacementCommand,
      close: vi.fn(),
    } as unknown as BoundedCdpSession;
    const reconnectSession = vi.fn(async () => ({
      session: replacementSession,
      initialNavigationHistory: { currentIndex: 0, entries: [{ url: detailUrl }] },
    }));
    const surface = new CdpChatGptSettingsSurface(
      {
        classifyOwnedSettingsLocation: vi.fn((_targetId: string, url: string) => ({
          kind: "chatgpt_settings" as const,
          target: {
            id: "owned",
            type: "page",
            url,
            webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
          },
        })),
      } as unknown as ChatGptLoopbackCdpTransport,
      { targetId: "owned", command: oldCommand, close: oldClose } as unknown as BoundedCdpSession,
      binding,
      undefined,
      reconnectSession,
    );

    await surface.ensureSettingsIndex();

    expect(reconnectSession).toHaveBeenCalledTimes(1);
    expect(oldClose).toHaveBeenCalledTimes(1);
    expect(replacementCommand).toHaveBeenCalledWith(
      "Runtime.evaluate",
      {
        expression: CHATGPT_REPLAY_CURRENT_SETTINGS_HASH_EXPRESSION,
        returnByValue: true,
        awaitPromise: false,
      },
      undefined,
    );
  });

  it("keeps one exact owned target across settings, Auth0, callback, and settings return", async () => {
    const target: CdpTarget = {
      id: "owned",
      type: "page",
      url: chatGptAppSettingsUrl(binding.appConnectorId),
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let listed: readonly CdpTarget[] = [target];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new")
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      if (url.pathname === "/json/list") return new Response(JSON.stringify(listed));
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
      oauthAuthorizationOrigins: ["https://issuer.example/"],
    });
    await transport.openOwnedSettingsTarget(binding.appConnectorId);

    listed = [
      {
        ...target,
        url: "https://issuer.example/u/login?state=must-not-leak&code_challenge=private",
      },
    ];
    await expect(transport.getOwnedSettingsTarget("owned")).resolves.toEqual({
      kind: "oauth_authorization",
      targetId: "owned",
      route: "https://issuer.example/",
    });

    listed = [
      {
        ...target,
        url: "https://chatgpt.com/connector/oauth/callback-id?code=must-not-leak&state=private",
      },
    ];
    await expect(transport.getOwnedSettingsTarget("owned")).resolves.toEqual({
      kind: "chatgpt_oauth_callback",
      targetId: "owned",
      route: "https://chatgpt.com/connector/oauth/",
    });

    listed = [{ ...target, url: "https://chatgpt.com/" }];
    await expect(transport.getOwnedSettingsTarget("owned")).resolves.toEqual({
      kind: "chatgpt_settings_return",
      targetId: "owned",
      route: "https://chatgpt.com/",
    });

    listed = [
      {
        ...target,
        url: chatGptAppSettingsUrl(binding.appConnectorId),
      },
    ];
    await expect(transport.getOwnedSettingsTarget("owned")).resolves.toMatchObject({
      kind: "chatgpt_settings",
      target: { id: "owned" },
    });
  });

  it("waits through only the exact owned settings shell and binds detail routes to its connector", async () => {
    const target: CdpTarget = {
      id: "owned",
      type: "page",
      url: chatGptAppSettingsUrl(binding.appConnectorId),
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let listed: readonly CdpTarget[] = [target];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new")
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      if (url.pathname === "/json/list") return new Response(JSON.stringify(listed));
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });
    await transport.openOwnedSettingsTarget(binding.appConnectorId);

    for (const [route, expected] of [
      ["https://chatgpt.com/#settings", "https://chatgpt.com/#settings"],
      ["https://chatgpt.com/#settings/", "https://chatgpt.com/#settings"],
      [
        `https://chatgpt.com/plugins/plugin_${binding.appConnectorId}`,
        `https://chatgpt.com/plugins/plugin_${binding.appConnectorId}`,
      ],
    ] as const) {
      listed = [{ ...target, url: route }];
      await expect(transport.getOwnedSettingsTarget("owned")).resolves.toEqual({
        kind: "owned_navigation_pending",
        targetId: "owned",
        route: expected,
      });
    }

    listed = [{ ...target, url: "https://chatgpt.com/plugins" }];
    await expect(transport.getOwnedSettingsTarget("owned")).resolves.toMatchObject({
      kind: "chatgpt_settings",
      target: { id: "owned" },
    });

    listed = [
      {
        ...target,
        url: chatGptAppSettingsUrl(binding.appConnectorId),
      },
    ];
    await expect(transport.getOwnedSettingsTarget("owned")).resolves.toMatchObject({
      kind: "chatgpt_settings",
      target: { id: "owned" },
    });

    for (const route of [
      "https://chatgpt.com/plugins/plugin_asdk_app_other#settings/Plugins/plugin_asdk_app_other",
      `https://chatgpt.com/plugins/plugin_${binding.appConnectorId}/unexpected#settings/Plugins/plugin_${binding.appConnectorId}`,
      "https://chatgpt.com/c/unrelated",
    ]) {
      listed = [{ ...target, url: route }];
      await expect(transport.getOwnedSettingsTarget("owned")).rejects.toThrow(
        "CHATGPT_UTILITY_TARGET_ROUTE_MISMATCH",
      );
    }
  });

  it("accepts only exact empty and about:blank states as owned navigation transitions", async () => {
    const target: CdpTarget = {
      id: "owned",
      type: "page",
      url: "https://chatgpt.com/#settings/Connectors",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let listed: readonly CdpTarget[] = [target];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new")
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      if (url.pathname === "/json/list") return new Response(JSON.stringify(listed));
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });
    await transport.openOwnedSettingsTarget(binding.appConnectorId);

    for (const [url, route] of [
      ["", "empty"],
      ["about:blank", "about:blank"],
    ] as const) {
      listed = [{ ...target, url }];
      await expect(transport.getOwnedSettingsTarget("owned")).resolves.toEqual({
        kind: "owned_navigation_pending",
        targetId: "owned",
        route,
      });
    }

    for (const [url, evidence] of [
      ["about:blank?token=must-not-leak#private", "scheme=about:path=blank-with-extra-state"],
      ["chrome-error://chromewebdata/", "scheme=chrome-error:path=error"],
      ["chrome://newtab/", "scheme=chrome:path=internal"],
      ["data:text/html,must-not-leak", "scheme=data:path=redacted"],
    ] as const) {
      listed = [{ ...target, url }];
      const error = await transport.getOwnedSettingsTarget("owned").catch((reason) => reason);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(`CHATGPT_UTILITY_TARGET_LOCATION_INVALID:${evidence}`);
      expect((error as Error).message).not.toContain("must-not-leak");
      expect((error as Error).message).not.toContain("private");
    }
  });

  it("accepts only the exact bare ChatGPT settings-return transition", async () => {
    const target: CdpTarget = {
      id: "owned",
      type: "page",
      url: "https://chatgpt.com/#settings/Connectors",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let listed: readonly CdpTarget[] = [target];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new")
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      if (url.pathname === "/json/list") return new Response(JSON.stringify(listed));
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });
    await transport.openOwnedSettingsTarget(binding.appConnectorId);

    for (const route of [
      "https://chatgpt.com/?_tm=oauth_failed_generic",
      "https://chatgpt.com/#unrelated",
      "https://chatgpt.com/c/unrelated",
    ]) {
      listed = [{ ...target, url: route }];
      await expect(transport.getOwnedSettingsTarget("owned")).rejects.toThrow(
        "CHATGPT_UTILITY_TARGET_ROUTE_MISMATCH",
      );
    }
  });

  it("fails closed for an unknown origin, target closure, or duplicate target identity", async () => {
    const target: CdpTarget = {
      id: "owned",
      type: "page",
      url: "https://chatgpt.com/#settings/Connectors",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let listed: readonly CdpTarget[] = [target];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new")
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      if (url.pathname === "/json/list") return new Response(JSON.stringify(listed));
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
      oauthAuthorizationOrigins: ["https://issuer.example/"],
    });
    await transport.openOwnedSettingsTarget(binding.appConnectorId);

    listed = [
      {
        ...target,
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/reused-identity",
      },
    ];
    await expect(transport.getOwnedSettingsTarget("owned")).rejects.toThrow(
      "CHATGPT_UTILITY_TARGET_IDENTITY_CHANGED",
    );

    listed = [{ ...target, url: "https://evil.example/u/login" }];
    await expect(transport.getOwnedSettingsTarget("owned")).rejects.toThrow(
      "CHATGPT_UTILITY_TARGET_ORIGIN_MISMATCH",
    );

    listed = [];
    await expect(transport.getOwnedSettingsTarget("owned")).rejects.toThrow(
      "CHATGPT_UTILITY_TARGET_MISSING_OR_AMBIGUOUS",
    );

    listed = [target, { ...target }];
    await expect(transport.getOwnedSettingsTarget("owned")).rejects.toThrow(
      "CHATGPT_UTILITY_TARGET_MISSING_OR_AMBIGUOUS",
    );
  });

  it("opens the exact settings URL with PUT and closes only the target it created", async () => {
    const target: CdpTarget = {
      id: "owned",
      type: "page",
      url: "https://chatgpt.com/#settings/Connectors",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let present = true;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        expect(init?.method).toBe("PUT");
        const requested = new URL(decodeURIComponent(url.search.slice(1)));
        expect(requested.protocol).toBe("about:");
        expect(requested.pathname).toBe("blank");
        expect(requested.href).toContain("omnicodex");
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      }
      if (url.pathname === "/json/list") {
        return new Response(JSON.stringify(present ? [target] : []));
      }
      if (url.pathname === "/json/close/owned") {
        expect(init?.method).toBe("PUT");
        present = false;
        return new Response("Target is closing");
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });
    expect((await transport.openOwnedSettingsTarget("asdk_app_exact")).id).toBe("owned");
    await expect(transport.closeOwnedTarget("foreign")).rejects.toThrow(
      "CHATGPT_UTILITY_TARGET_NOT_OWNED",
    );
    await transport.closeOwnedTarget("owned");
    expect(present).toBe(false);
  });

  it("uses the creation receipt without waiting for a transient live URL", async () => {
    const target: CdpTarget = {
      id: "owned",
      type: "page",
      url: "https://chatgpt.com/#settings/Connectors",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/owned",
    };
    let listReads = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/json/new") {
        return new Response(
          JSON.stringify({ ...target, url: decodeURIComponent(url.search.slice(1)) }),
        );
      }
      if (url.pathname === "/json/list") {
        listReads += 1;
        return new Response(JSON.stringify(listReads === 1 ? [{ ...target, url: "" }] : [target]));
      }
      throw new Error(`unexpected ${url}`);
    });
    const transport = new ChatGptLoopbackCdpTransport({
      endpoint: "http://127.0.0.1:9222",
      fetch: fetch as typeof globalThis.fetch,
    });

    expect((await transport.openOwnedSettingsTarget("asdk_app_exact")).id).toBe("owned");
    expect(listReads).toBe(0);
  });
});

function control(ref: string, role: string, name: string, checked?: boolean) {
  return {
    ref,
    role,
    name,
    ...(checked === undefined ? {} : { checked }),
    selectorClass: "accessible-role-name" as const,
  };
}

async function appIndexSnapshot(label: string): Promise<ChatGptSettingsSnapshot> {
  const transport = {
    getOwnedSettingsTarget: vi.fn(async () => ({
      kind: "chatgpt_settings" as const,
      target: {
        id: "owned",
        type: "page",
        url: "https://chatgpt.com/#settings/Plugins",
      },
    })),
  } as unknown as ChatGptLoopbackCdpTransport;
  const candidate = label.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const app = binding.appName.toLocaleLowerCase();
  const validSuffixes = new Set([
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
  ]);
  const matches =
    candidate === app ||
    (candidate.startsWith(`${app} `) && validSuffixes.has(candidate.slice(app.length + 1)))
      ? [label]
      : [];
  const command = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "Runtime.evaluate") {
      expect(params).toMatchObject({ expression: CHATGPT_SETTINGS_DOCUMENT_EXPRESSION });
      return { result: { objectId: "document-object" } };
    }
    if (method === "Runtime.callFunctionOn") {
      expect(params).toMatchObject({
        objectId: "document-object",
        functionDeclaration: CHATGPT_SETTINGS_CONTROL_SNAPSHOT_FUNCTION,
      });
      return {
        result: {
          value: matches.map((name, index) => ({
            ref: `oc-${index}`,
            role: "button",
            name,
          })),
        },
      };
    }
    if (method === "Runtime.releaseObject") return {};
    throw new Error(`unexpected ${method}`);
  });
  const session = { targetId: "owned", command } as unknown as BoundedCdpSession;

  return new CdpChatGptSettingsSurface(transport, session, binding).snapshot();
}
