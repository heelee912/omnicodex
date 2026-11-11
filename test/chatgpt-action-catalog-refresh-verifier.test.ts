import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ChatGptActionCatalogControlClient } from "../src/infrastructure/chatgpt/chatgpt-action-catalog-control-client.js";
import type { ChatGptApprovalBinding } from "../src/infrastructure/chatgpt/chatgpt-app-approval-adapter.js";
import {
  type ChatGptActionCatalogReadback,
  type ChatGptActionSchemaReadback,
  type ChatGptSettingsSnapshot,
  type ChatGptSettingsSurface,
  OMNICODEX_REQUIRED_ACTION_NAMES,
} from "../src/infrastructure/chatgpt/chatgpt-app-settings-reconciler.js";
import { ChatGptActionCatalogRefreshVerifier } from "../src/infrastructure/operations/chatgpt-action-catalog-refresh-verifier.js";
import type { OmniCodexOperationalLogEntry } from "../src/infrastructure/operations/operational-log.js";

const pid = 4242;
const revision = "1".repeat(64);
const schemaDigest = "2".repeat(64);
const descriptionDigest = "3".repeat(64);
const actionContractDigest = "6".repeat(64);
const properties =
  "arguments,expectedCatalogRevision,input,name,ordering,payload,query,timeoutMs,toolId";
const required = "";
const defaultPageToolCounts = [100, 100, 62] as const;
const criticalSchema: ChatGptActionSchemaReadback = {
  toolName: "call_native_tool",
  inputProperties: properties.split(","),
  requiredInputProperties: [],
};
const compactCriticalDescription = "Call one native OmniCodex tool.";
const requiredActionCatalog: readonly ChatGptActionCatalogReadback[] = [
  { toolName: "call_native_tool", description: "Call one native tool." },
  { toolName: "app_server_rpc", description: "Call one App Server method." },
  { toolName: "codex_app__list_threads", description: "List Codex threads." },
  { toolName: "codex_app__read_thread", description: "Read one Codex thread." },
  {
    toolName: "codex__app_server__fs_readFile",
    description: "Read one workspace file.",
  },
  { toolName: "codex__app_server__fs_writeFile", description: "Write one workspace file." },
  { toolName: "codex__app_server__command_exec", description: "Run one exact command." },
];
const activatedActionCatalog = actionCatalogForCount(
  defaultPageToolCounts.reduce((sum, count) => sum + count, 0),
);
const binding: ChatGptApprovalBinding = {
  appConnectorId: "connector-1",
  appName: "OmniCodex",
  oracleRunId: "run-1",
  sessionId: "session-1",
  correlationId: "correlation-1",
  mcpServerResource: "https://owner.example/mcp/full",
  mcpSurface: "/mcp/full",
};

class MemoryLog {
  readonly entries: OmniCodexOperationalLogEntry[];
  readonly readLimits: Array<number | undefined> = [];

  constructor(entries: readonly OmniCodexOperationalLogEntry[] = []) {
    this.entries = [...entries];
  }

  async read(limit?: number): Promise<readonly OmniCodexOperationalLogEntry[]> {
    this.readLimits.push(limit);
    return [...this.entries];
  }
}

class SettingsSurface implements ChatGptSettingsSurface {
  readonly #onRefresh: () => void;
  readonly #schemaAfterRefresh: readonly ChatGptActionSchemaReadback[] | undefined;
  readonly #actionCatalogAfterRefresh: readonly ChatGptActionCatalogReadback[];
  readonly #actionToolCountAfterRefresh: number;
  readonly #postRefreshSnapshot: Partial<
    Pick<
      ChatGptSettingsSnapshot,
      | "exactAppVisible"
      | "detailVisible"
      | "connectorMatched"
      | "resourceMatched"
      | "connected"
      | "fullAccess"
    >
  >;
  readonly #domRevisionAfterRefresh: string;
  #transientSnapshotsAfterRefresh: number;
  readonly #staleActionCatalogAfterRefresh: readonly ChatGptActionCatalogReadback[] | undefined;
  #staleSnapshotsAfterRefresh: number;
  #refreshed = false;
  #targetId = "target-1";

  constructor(
    options: {
      onRefresh?: () => void;
      schemaAfterRefresh?: readonly ChatGptActionSchemaReadback[];
      actionCatalogAfterRefresh?: readonly ChatGptActionCatalogReadback[];
      actionToolCountAfterRefresh?: number;
      postRefreshSnapshot?: Partial<
        Pick<
          ChatGptSettingsSnapshot,
          | "exactAppVisible"
          | "detailVisible"
          | "connectorMatched"
          | "resourceMatched"
          | "connected"
          | "fullAccess"
        >
      >;
      domRevisionAfterRefresh?: string;
      transientSnapshotsAfterRefresh?: number;
      staleActionCatalogAfterRefresh?: readonly ChatGptActionCatalogReadback[];
      staleSnapshotsAfterRefresh?: number;
    } = {},
  ) {
    this.#onRefresh = options.onRefresh ?? (() => undefined);
    this.#schemaAfterRefresh = options.schemaAfterRefresh ?? [criticalSchema];
    this.#actionCatalogAfterRefresh = options.actionCatalogAfterRefresh ?? activatedActionCatalog;
    this.#actionToolCountAfterRefresh =
      options.actionToolCountAfterRefresh ?? this.#actionCatalogAfterRefresh.length;
    this.#postRefreshSnapshot = options.postRefreshSnapshot ?? {};
    this.#domRevisionAfterRefresh = options.domRevisionAfterRefresh ?? "dom-1";
    this.#transientSnapshotsAfterRefresh = options.transientSnapshotsAfterRefresh ?? 0;
    this.#staleActionCatalogAfterRefresh = options.staleActionCatalogAfterRefresh;
    this.#staleSnapshotsAfterRefresh = options.staleSnapshotsAfterRefresh ?? 0;
  }

  changeTarget(): void {
    this.#targetId = "target-changed";
  }

  async snapshot(): Promise<ChatGptSettingsSnapshot> {
    if (this.#refreshed && this.#transientSnapshotsAfterRefresh > 0) {
      this.#transientSnapshotsAfterRefresh -= 1;
      return {
        targetId: this.#targetId,
        route: "about:blank",
        domRevision: `navigation-${this.#transientSnapshotsAfterRefresh}`,
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
    if (
      this.#refreshed &&
      this.#staleSnapshotsAfterRefresh > 0 &&
      this.#staleActionCatalogAfterRefresh !== undefined
    ) {
      this.#staleSnapshotsAfterRefresh -= 1;
      return {
        targetId: this.#targetId,
        route: "/#settings/Connectors/connector-1",
        domRevision: "dom-0",
        exactAppVisible: true,
        detailVisible: true,
        connectorMatched: true,
        resourceMatched: true,
        connected: true,
        fullAccess: true,
        actionSchemas: [criticalSchema],
        actionCatalog: this.#staleActionCatalogAfterRefresh,
        actionToolCount: this.#staleActionCatalogAfterRefresh.length,
        controls: {
          refreshActions: {
            ref: "refresh",
            role: "button",
            name: "새로 고침",
            selectorClass: "accessible-role-name",
          },
        },
      };
    }
    return {
      targetId: this.#targetId,
      route: "/#settings/Connectors/connector-1",
      domRevision: this.#refreshed ? this.#domRevisionAfterRefresh : "dom-0",
      exactAppVisible: true,
      detailVisible: true,
      connectorMatched: true,
      resourceMatched: true,
      connected: true,
      fullAccess: true,
      ...(this.#refreshed && this.#schemaAfterRefresh !== undefined
        ? { actionSchemas: this.#schemaAfterRefresh }
        : {}),
      ...(this.#refreshed
        ? {
            actionCatalog: this.#actionCatalogAfterRefresh,
            actionToolCount: this.#actionToolCountAfterRefresh,
          }
        : {}),
      ...(this.#refreshed ? this.#postRefreshSnapshot : {}),
      controls: {
        refreshActions: {
          ref: "refresh",
          role: "button",
          name: "새로 고침",
          selectorClass: "accessible-role-name",
        },
      },
    };
  }

  async activate(ref: string, expectedDomRevision: string): Promise<void> {
    expect(ref).toBe("refresh");
    expect(expectedDomRevision).toBe("dom-0");
    this.#refreshed = true;
    this.#onRefresh();
  }
}

describe("ChatGptActionCatalogRefreshVerifier", () => {
  it("uses the bounded controls snapshot and proves the full catalog from post-click MCP logs", async () => {
    const log = new MemoryLog();
    let refreshed = false;
    let fullSnapshots = 0;
    let controlSnapshots = 0;
    const surface: ChatGptSettingsSurface = {
      snapshot: async () => {
        fullSnapshots += 1;
        throw new Error("the virtualized action catalog must not be rendered");
      },
      snapshotControls: async () => {
        controlSnapshots += 1;
        return {
          targetId: "target-bounded",
          route: "/#settings/Connectors/connector-1",
          domRevision: refreshed ? "controls-1" : "controls-0",
          exactAppVisible: true,
          detailVisible: true,
          connectorMatched: true,
          resourceMatched: true,
          connected: true,
          fullAccess: true,
          controls: {
            refreshActions: {
              ref: "refresh-bounded",
              role: "button",
              name: "Refresh",
              selectorClass: "accessible-role-name",
            },
          },
        };
      },
      activate: async (ref, revisionBefore) => {
        expect(ref).toBe("refresh-bounded");
        expect(revisionBefore).toBe("controls-0");
        refreshed = true;
        log.entries.push(...postClickEntries("bounded-control-refresh"));
      },
    };

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(fullSnapshots).toBe(0);
    expect(controlSnapshots).toBeGreaterThan(1);
    expect(result.actionSnapshotEvidence).toMatchObject({
      source: "post_click_mcp_catalog",
      visibleActionToolCount: activatedActionCatalog.length,
    });
    expect(result.operationalEvidence?.correlationId).toBe("bounded-control-refresh");
  });

  it("has no implicit completion deadline and reads the complete operational history", async () => {
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      onRefresh: () => log.entries.push(...postClickEntries("unbounded-default", 10_000_000)),
    });
    const base = Date.now();
    let reads = 0;

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      pollIntervalMs: 10,
      now: () => new Date(base + reads++ * 61_000),
    });

    expect(result.verificationSource).toBe("post_click_mcp_catalog");
    expect(log.readLimits.length).toBeGreaterThan(0);
    expect(log.readLimits.every((limit) => limit === undefined)).toBe(true);
  });

  it("labels exact operational verification truthfully even when the DOM schema also renders", async () => {
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      onRefresh: () => log.entries.push(...postClickEntries("post-click")),
      schemaAfterRefresh: [criticalSchema],
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(result).toMatchObject({
      state: "refreshed",
      connected: true,
      fullAccess: true,
      verificationSource: "post_click_mcp_catalog",
      operationalEvidence: {
        daemonPid: pid,
        correlationId: "post-click",
        catalogRevision: revision,
        catalogToolCount: 262,
        catalogPageToolCounts: defaultPageToolCounts,
        criticalToolInputSchemaSha256: schemaDigest,
        expectedLocalInputSchemaSha256: schemaDigest,
      },
      actionSnapshotEvidence: {
        source: "post_click_mcp_catalog",
        state: "persisted",
        targetId: "target-1",
        refreshedFromDomRevision: "dom-0",
        persistedDomRevision: expect.any(String),
        visibleActionToolCount: activatedActionCatalog.length,
        completedSteps: [],
      },
      verifiedSchemas: [criticalSchema],
      verifiedActionNames: OMNICODEX_REQUIRED_ACTION_NAMES,
    });
    expect(result.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.actionSchemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts transport-specific page boundaries when the complete catalog is identical", async () => {
    const transportPageToolCounts = [80, 60, 122] as const;
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      onRefresh: () =>
        log.entries.push(
          ...postClickEntries("transport-specific-pages", 10, transportPageToolCounts),
        ),
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(result.operationalEvidence).toMatchObject({
      correlationId: "transport-specific-pages",
      catalogToolCount: 262,
      catalogPageToolCounts: transportPageToolCounts,
    });
  });

  it("waits past an unchanged stale snapshot until the UI matches the live catalog exactly", async () => {
    const staleCatalog = activatedActionCatalog.slice(0, -1);
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      staleActionCatalogAfterRefresh: staleCatalog,
      staleSnapshotsAfterRefresh: 1,
      onRefresh: () => log.entries.push(...postClickEntries("post-click-after-stale-ui")),
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(result.verificationSource).toBe("post_click_mcp_catalog");
    expect(result.actionSnapshotEvidence.visibleActionToolCount).toBe(
      activatedActionCatalog.length,
    );
    expect(result.operationalEvidence?.correlationId).toBe("post-click-after-stale-ui");
  });

  it("accepts additive optional fields while matching the exact live pre/post-click schema", async () => {
    const additiveProperties = `${properties},omnicodexGoalContext,omnicodexInvocationId`;
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      schemaAfterRefresh: [{ ...criticalSchema, inputProperties: additiveProperties.split(",") }],
      onRefresh: () =>
        log.entries.push(
          ...postClickEntries("additive-optional-field").map((item) =>
            item.event === "mcp_tool_catalog_observed" && item.details?.criticalToolCount === 1
              ? {
                  ...item,
                  details: { ...item.details, criticalToolProperties: additiveProperties },
                }
              : item,
          ),
        ),
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => ({
        ...localBaseline(),
        chatGptCriticalToolProperties: additiveProperties,
      }),
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(result.operationalEvidence?.criticalToolInputSchemaSha256).toBe(schemaDigest);
  });

  it("accepts the clicked refresh when the complete post-click catalog is authoritative", async () => {
    const log = new MemoryLog();
    let activated = false;
    const surface = new SettingsSurface({
      domRevisionAfterRefresh: "dom-0",
      actionCatalogAfterRefresh: [],
      onRefresh: () => {
        activated = true;
        log.entries.push(...postClickEntries("description-only-post-click"));
      },
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 80,
      pollIntervalMs: 10,
    });
    expect(activated).toBe(true);
    expect(result.actionSnapshotEvidence.source).toBe("post_click_mcp_catalog");
    expect(result.operationalEvidence?.catalogToolCount).toBe(activatedActionCatalog.length);
  });

  it("does not reject an incomplete virtualized UI list when the server traversal is complete", async () => {
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      actionCatalogAfterRefresh: [
        {
          toolName: criticalSchema.toolName,
          description: compactCriticalDescription,
        },
      ],
      actionToolCountAfterRefresh: 1,
      onRefresh: () => log.entries.push(...postClickEntries("post-click-partial-ui")),
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 80,
      pollIntervalMs: 10,
    });
    expect(result.operationalEvidence?.catalogToolCount).toBe(activatedActionCatalog.length);
    expect(result.actionSnapshotEvidence.source).toBe("post_click_mcp_catalog");
  });

  it("does not use a stale equal-size virtualized UI list as catalog authority", async () => {
    const expectedName = activatedActionCatalog.at(-1)?.toolName;
    if (expectedName === undefined) throw new Error("Expected a fixture action");
    const replacementName = "codex__fixture__unexpected_replacement";
    const visibleCatalog = activatedActionCatalog.map((action) =>
      action.toolName === expectedName ? { ...action, toolName: replacementName } : action,
    );
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      actionCatalogAfterRefresh: visibleCatalog,
      onRefresh: () => log.entries.push(...postClickEntries("post-click-equal-size-mismatch")),
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 80,
      pollIntervalMs: 10,
    });
    expect(result.operationalEvidence?.catalogToolNamesSha256).toBe(
      localBaseline().catalogToolNamesSha256,
    );
  });

  it("accepts matched transport evidence without enforcing adapter policy prose", async () => {
    const catalog = activatedActionCatalog.map((action) =>
      action.toolName === "codex__functions__exec"
        ? { ...action, description: "Use this for every OmniCodex operation." }
        : action,
    );
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      actionCatalogAfterRefresh: catalog,
      onRefresh: () => log.entries.push(...postClickEntries("post-click-ui-invalid")),
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(),
      timeoutMs: 80,
      pollIntervalMs: 10,
    });

    expect(result.verificationSource).toBe("post_click_mcp_catalog");
  });

  it("accepts a complete paginated catalog when the critical tool is not on the first page", async () => {
    const counts = [100, 100, 100, 62] as const;
    const actionCatalog = actionCatalogForCount(counts.reduce((sum, count) => sum + count, 0));
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      actionCatalogAfterRefresh: actionCatalog,
      onRefresh: () =>
        log.entries.push(
          ...postClickEntries("post-click-paginated", 10, counts, counts.length - 1),
        ),
      transientSnapshotsAfterRefresh: 2,
    });

    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(counts, actionCatalog),
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(result).toMatchObject({
      state: "refreshed",
      connected: true,
      fullAccess: true,
      connectorMatched: true,
      resourceMatched: true,
      verificationSource: "post_click_mcp_catalog",
      operationalEvidence: {
        source: "post_click_mcp_catalog",
        daemonPid: pid,
        correlationId: "post-click-paginated",
        catalogRevision: revision,
        catalogToolCount: 362,
        catalogPageToolCounts: counts,
        criticalToolInputSchemaSha256: schemaDigest,
        criticalToolDescriptionSha256: descriptionDigest,
      },
      verifiedSchemas: [criticalSchema],
      verifiedActionNames: OMNICODEX_REQUIRED_ACTION_NAMES,
      actionSnapshotEvidence: {
        source: "post_click_mcp_catalog",
        state: "persisted",
        visibleActionToolCount: actionCatalog.length,
      },
    });
    expect(result.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.actionSchemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not report refreshed without an operational total-count baseline", async () => {
    await expect(
      new ChatGptActionCatalogRefreshVerifier(new MemoryLog([])).verify(
        new SettingsSurface({ schemaAfterRefresh: [criticalSchema] }),
        binding,
        { timeoutMs: 200, pollIntervalMs: 10 },
      ),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
  });

  it("rejects absent DOM schemas when no exact pre-click catalog baseline is available", async () => {
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      schemaAfterRefresh: [],
      onRefresh: () => log.entries.push(...postClickEntries("no-baseline")),
    });

    await expect(
      new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
        timeoutMs: 80,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
  });

  it("accepts a multi-page local baseline whose complete post-click sequence matches", async () => {
    const counts = [100, 100, 37] as const;
    const actionCatalog = actionCatalogForCount(counts.reduce((sum, count) => sum + count, 0));
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      actionCatalogAfterRefresh: actionCatalog,
      onRefresh: () => log.entries.push(...postClickEntries("exact-multiple", 10, counts, 1)),
      schemaAfterRefresh: [criticalSchema],
    });
    const result = await new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
      expectedDaemonPid: pid,
      readLocalCatalogBaseline: async () => localBaseline(counts, actionCatalog),
      timeoutMs: 500,
      pollIntervalMs: 10,
    });

    expect(result.verificationSource).toBe("post_click_mcp_catalog");
    expect(result.operationalEvidence?.catalogPageToolCounts).toEqual(counts);
    expect(result.verifiedSchemas).toEqual([criticalSchema]);
  });

  it("does not accept a catalog observation that existed before the click", async () => {
    const log = new MemoryLog([
      ...baselineEntries(),
      ...postClickEntries("already-present", -5_000),
    ]);
    await expect(
      new ChatGptActionCatalogRefreshVerifier(log).verify(
        new SettingsSurface({ schemaAfterRefresh: [criticalSchema] }),
        binding,
        {
          expectedDaemonPid: pid,
          readLocalCatalogBaseline: async () => localBaseline(),
          timeoutMs: 80,
          pollIntervalMs: 10,
        },
      ),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
  });

  it("fails closed when the post-click schema digest differs from the current daemon baseline", async () => {
    const log = new MemoryLog();
    const surface = new SettingsSurface({
      schemaAfterRefresh: [criticalSchema],
      onRefresh: () =>
        log.entries.push(
          ...postClickEntries("wrong-schema").map((entry) =>
            entry.event === "mcp_tool_catalog_observed" && entry.details?.criticalToolCount === 1
              ? {
                  ...entry,
                  details: { ...entry.details, criticalToolInputSchemaSha256: "9".repeat(64) },
                }
              : entry,
          ),
        ),
    });
    await expect(
      new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
        expectedDaemonPid: pid,
        readLocalCatalogBaseline: async () => localBaseline(),
        timeoutMs: 80,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
  });

  it("rejects wrong PID, revision, digest, shape, page count, and incomplete post-click catalogs", async () => {
    const corruptions: ReadonlyArray<
      (entries: readonly OmniCodexOperationalLogEntry[]) => readonly OmniCodexOperationalLogEntry[]
    > = [
      (entries) => entries.map((entry) => ({ ...entry, pid: pid + 1 })),
      (entries) =>
        entries.map((entry) =>
          entry.event === "mcp_tool_catalog_observed"
            ? {
                ...entry,
                details: { ...entry.details, catalogRevision: "8".repeat(64) },
              }
            : entry,
        ),
      (entries) =>
        entries.map((entry) =>
          entry.event === "mcp_tool_catalog_observed" && entry.details?.criticalToolCount === 1
            ? {
                ...entry,
                details: { ...entry.details, criticalToolDescriptionSha256: "7".repeat(64) },
              }
            : entry,
        ),
      (entries) =>
        entries.map((entry) =>
          entry.event === "mcp_tool_catalog_observed" && entry.details?.criticalToolCount === 1
            ? {
                ...entry,
                details: { ...entry.details, criticalToolRequired: "prompt" },
              }
            : entry,
        ),
      (entries) =>
        entries.map((entry) =>
          entry.event === "mcp_tool_catalog_observed" && entry.details?.criticalToolCount === 1
            ? {
                ...entry,
                details: { ...entry.details, criticalToolProperties: "input,prompt" },
              }
            : entry,
        ),
      (entries) =>
        entries.map((entry) =>
          entry.event === "mcp_tool_catalog_observed"
            ? { ...entry, details: { ...entry.details, toolCount: 2 } }
            : entry,
        ),
      (entries) =>
        entries.map((entry) =>
          entry.event === "mcp_tool_catalog_observed" && entry.details?.cursorPresent === false
            ? {
                ...entry,
                details: {
                  ...entry.details,
                  criticalToolCount: 1,
                  criticalToolProperties: properties,
                  criticalToolRequired: required,
                  criticalToolDescriptionSha256: descriptionDigest,
                  criticalToolInputSchemaSha256: schemaDigest,
                },
              }
            : entry,
        ),
      (entries) =>
        entries.map((entry) =>
          entry.event === "mcp_tool_catalog_observed"
            ? { ...entry, details: { ...entry.details, criticalToolCount: 0 } }
            : entry,
        ),
      (entries) => {
        const catalog = entries.find((entry) => entry.event === "mcp_tool_catalog_observed");
        return catalog === undefined
          ? entries
          : [
              ...entries,
              {
                ...catalog,
                timestamp: new Date(Date.parse(catalog.timestamp) + 1).toISOString(),
                details: {
                  ...catalog.details,
                  cursorPresent: true,
                  criticalToolCount: 0,
                },
              },
            ];
      },
      (entries) => {
        let removed = false;
        return entries.filter((entry) => {
          if (entry.event !== "mcp_tool_catalog_observed" || removed) return true;
          removed = true;
          return false;
        });
      },
    ];

    for (const [index, corrupt] of corruptions.entries()) {
      const log = new MemoryLog();
      const surface = new SettingsSurface({
        onRefresh: () => log.entries.push(...corrupt(postClickEntries(`corrupt-catalog-${index}`))),
      });
      await expect(
        new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
          expectedDaemonPid: pid,
          readLocalCatalogBaseline: async () => localBaseline(),
          timeoutMs: 50,
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
    }
  });

  it.each([
    ["disconnected", { connected: false }, "dom-1"],
    ["connector mismatch", { connectorMatched: false }, "dom-1"],
    ["resource mismatch", { resourceMatched: false }, "dom-1"],
  ] as const)(
    "rejects exact operational evidence with %s settings",
    async (_, state, revisionAfter) => {
      const log = new MemoryLog();
      const surface = new SettingsSurface({
        onRefresh: () => log.entries.push(...postClickEntries("invalid-post-click-settings")),
        postRefreshSnapshot: state,
        domRevisionAfterRefresh: revisionAfter,
      });

      await expect(
        new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
          expectedDaemonPid: pid,
          readLocalCatalogBaseline: async () => localBaseline(),
          timeoutMs: 80,
          pollIntervalMs: 10,
        }),
      ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
    },
  );

  it("rejects operational evidence when the exact settings target changes after Refresh", async () => {
    const log = new MemoryLog();
    let surface!: SettingsSurface;
    surface = new SettingsSurface({
      schemaAfterRefresh: [criticalSchema],
      onRefresh: () => {
        log.entries.push(...postClickEntries("changed-target"));
        surface.changeTarget();
      },
    });
    await expect(
      new ChatGptActionCatalogRefreshVerifier(log).verify(surface, binding, {
        expectedDaemonPid: pid,
        readLocalCatalogBaseline: async () => localBaseline(),
        timeoutMs: 80,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_NOT_ACTIVATED");
  });

  it("accepts an exact page-free ChatGPT control-plane refresh readback", async () => {
    const baseline = localBaseline();
    const refresh = async () => ({
      linkId: "link-exact",
      actionCount: baseline.chatGptActionToolCount,
      actionNames: baseline.chatGptActionToolNames,
      actionNamesSha256: baseline.chatGptActionToolNamesSha256,
      actionSchemas: [criticalSchema],
      refreshReceiptSha256: "4".repeat(64),
    });
    const client = { refresh } as unknown as ChatGptActionCatalogControlClient;

    const result = await new ChatGptActionCatalogRefreshVerifier().verifyControlPlane(
      client,
      binding,
      {
        expectedDaemonPid: pid,
        readLocalCatalogBaseline: async () => baseline,
      },
    );

    expect(result.verificationSource).toBe("chatgpt_control_plane_catalog");
    expect(result.actionSnapshotEvidence).toMatchObject({
      source: "chatgpt_control_plane_catalog",
      targetId: "link-exact",
      visibleActionToolCount: baseline.chatGptActionToolCount,
      visibleActionNamesSha256: baseline.chatGptActionToolNamesSha256,
    });
    expect(result.operationalEvidence).toMatchObject({
      source: "chatgpt_control_plane_catalog",
      daemonPid: pid,
      catalogRevision: revision,
      actionContractSha256: actionContractDigest,
    });
  });

  it("rejects a control-plane catalog that omits one live action", async () => {
    const baseline = localBaseline();
    const actionNames = baseline.chatGptActionToolNames.slice(1);
    const client = {
      refresh: async () => ({
        linkId: "link-incomplete",
        actionCount: actionNames.length,
        actionNames,
        actionNamesSha256: toolNamesSha256(actionNames),
        actionSchemas: [criticalSchema],
        refreshReceiptSha256: "5".repeat(64),
      }),
    } as unknown as ChatGptActionCatalogControlClient;

    await expect(
      new ChatGptActionCatalogRefreshVerifier().verifyControlPlane(client, binding, {
        expectedDaemonPid: pid,
        readLocalCatalogBaseline: async () => baseline,
      }),
    ).rejects.toThrow("CHATGPT_ACTION_CATALOG_CONTROL_PLANE_PARITY_FAILED");
  });
});

function localBaseline(
  counts: readonly number[] = defaultPageToolCounts,
  actionCatalog: readonly ChatGptActionCatalogReadback[] = activatedActionCatalog,
) {
  const catalogToolNames = actionCatalog
    .map(({ toolName }) => toolName)
    .sort((left, right) => left.localeCompare(right, "en"));
  return {
    daemonPid: pid,
    catalogRevision: revision,
    catalogToolCount: counts.reduce((sum, count) => sum + count, 0),
    catalogPageToolCounts: counts,
    catalogToolNames,
    catalogToolNamesSha256: toolNamesSha256(catalogToolNames),
    catalogIdentitySha256: toolNamesSha256(catalogToolNames.map((name) => `fixture:${name}`)),
    modelToolCount: 1,
    unknownModelEffectCount: 0,
    criticalToolProperties: properties,
    criticalToolRequired: required,
    criticalToolDescriptionSha256: descriptionDigest,
    criticalToolInputSchemaSha256: schemaDigest,
    chatGptActionToolCount: catalogToolNames.length,
    chatGptActionToolNames: catalogToolNames,
    chatGptActionToolNamesSha256: toolNamesSha256(catalogToolNames),
    chatGptActionContractSha256: actionContractDigest,
    chatGptCriticalToolName: "call_native_tool",
    chatGptCriticalToolProperties: properties,
    chatGptCriticalToolRequired: required,
    chatGptCriticalToolDescriptionSha256: descriptionDigest,
    chatGptCriticalToolInputSchemaSha256: schemaDigest,
  } as const;
}

function actionCatalogForCount(count: number): readonly ChatGptActionCatalogReadback[] {
  if (count < requiredActionCatalog.length) throw new Error("Test catalog is too small");
  return [
    ...requiredActionCatalog,
    ...Array.from({ length: count - requiredActionCatalog.length }, (_, index) => ({
      toolName: `codex__fixture__tool_${String(index).padStart(4, "0")}`,
      description: `Fixture tool ${index}`,
    })),
  ];
}

function toolNamesSha256(names: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(names), "utf8").digest("hex");
}

function baselineEntries(): readonly OmniCodexOperationalLogEntry[] {
  return catalogEntries("baseline", Date.now() - 10_000);
}

function postClickEntries(
  correlationId: string,
  offsetMs = 10,
  counts: readonly number[] = defaultPageToolCounts,
  criticalPageIndex = Math.min(1, counts.length - 1),
): readonly OmniCodexOperationalLogEntry[] {
  const timestamp = Date.now() + offsetMs;
  return [
    entry(timestamp, "mcp_request_observed", {
      correlationId,
      httpMethod: "POST",
      surface: "full",
      rpcMethod: "initialize",
      sessionHeaderPresent: false,
      status: 200,
      outcome: "new_session_transport",
    }),
    ...catalogEntries(correlationId, timestamp + 1, counts, criticalPageIndex),
    entry(timestamp + counts.length + 2, "mcp_request_observed", {
      correlationId,
      httpMethod: "POST",
      surface: "full",
      rpcMethod: "tools/list",
      sessionHeaderPresent: true,
      status: 200,
      outcome: "existing_session_transport",
    }),
  ];
}

function catalogEntries(
  correlationId: string,
  timestamp: number,
  counts: readonly number[] = defaultPageToolCounts,
  criticalPageIndex = Math.min(1, counts.length - 1),
): readonly OmniCodexOperationalLogEntry[] {
  return counts.map((toolCount, index) =>
    entry(timestamp + index, "mcp_tool_catalog_observed", {
      correlationId,
      surface: "full",
      catalogRevision: revision,
      cursorPresent: index > 0,
      nextCursorPresent: index < counts.length - 1,
      toolCount,
      criticalToolCount: index === criticalPageIndex ? 1 : 0,
      ...(index === criticalPageIndex
        ? {
            criticalToolProperties: properties,
            criticalToolRequired: required,
            criticalToolDescriptionSha256: descriptionDigest,
            criticalToolInputSchemaSha256: schemaDigest,
          }
        : {}),
    }),
  );
}

function entry(
  timestamp: number,
  event: OmniCodexOperationalLogEntry["event"],
  details: NonNullable<OmniCodexOperationalLogEntry["details"]>,
): OmniCodexOperationalLogEntry {
  return { timestamp: new Date(timestamp).toISOString(), event, pid, details };
}
