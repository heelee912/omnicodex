import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { CodexAppHostToolExecutor } from "../src/application/codex-app-host-tool-executor.js";
import { LegacyMutationCoordinator } from "../src/infrastructure/mcp/legacy-mutation-coordinator.js";
import { LEGACY_MUTATION_STATUS_TOOL } from "../src/infrastructure/mcp/legacy-mutation-status-tool.js";
import { MutationReplayStore } from "../src/infrastructure/mcp/mutation-replay-store.js";
import {
  createOmniCodexMcpServer,
  type McpMutationReplayObservation,
  type McpProgressObservation,
  OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET,
  type OmniCodexMcpServerOptions,
} from "../src/infrastructure/mcp/omnicodex-mcp-server.js";

const originalRequest = {
  name: "codex_app__write_marker",
  arguments: { value: "synthetic-action" },
};
const requestSelector = { toolName: originalRequest.name, arguments: originalRequest.arguments };
type ServerOverrides = {
  [Key in keyof OmniCodexMcpServerOptions]?: OmniCodexMcpServerOptions[Key] | undefined;
};

function rig(
  options: {
    failNative?: boolean;
    changedContract?: boolean;
    holdNative?: () => Promise<void>;
    coordinator?: LegacyMutationCoordinator;
  } = {},
) {
  const coordinator = options.coordinator ?? LegacyMutationCoordinator.inMemory();
  const nativeCalls: unknown[] = [];
  const operations: string[] = [];
  const observations: McpMutationReplayObservation[] = [];
  const progress: McpProgressObservation[] = [];
  const appServer = {
    request: async <T>(method: string): Promise<T> => {
      if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
      throw new Error("unexpected synthetic App Server dispatch");
    },
  };
  const connections: Array<{
    client: Client;
    handle: ReturnType<typeof createOmniCodexMcpServer>;
  }> = [];
  return {
    coordinator,
    nativeCalls,
    operations,
    observations,
    progress,
    async connect(owner = "owner-a", overrides: ServerOverrides = {}) {
      const hostExecutor = new CodexAppHostToolExecutor(appServer, {
        appToolsContextThreadId: () => "synthetic-bridge",
        appTools: {
          close: () => undefined,
          listTools: async () => [
            {
              namespace: "codex_app",
              name: "write_marker",
              inputSchema: {
                type: "object",
                properties: {
                  value: { type: "string" },
                  ...(options.changedContract ? { shape: { type: "number" } } : {}),
                },
                required: ["value"],
                additionalProperties: false,
              },
            },
          ],
          callTool: async (params) => {
            nativeCalls.push(params.arguments);
            await options.holdNative?.();
            if (options.failNative) throw new Error("synthetic-dispatch-failed");
            return {
              success: true,
              contentItems: [{ type: "inputText", text: "synthetic-result-secret" }],
            };
          },
        },
      });
      const serverOptions: OmniCodexMcpServerOptions = {
        appServer,
        codexAppHostToolExecutor: hostExecutor,
        surface: "full",
        authorizationBinding: owner,
        correlationId: createHash("sha256")
          .update(`synthetic-session-${connections.length}`)
          .digest("hex")
          .slice(0, 32),
        legacyMutationCoordinator: coordinator,
        mutationReplayStore: MutationReplayStore.inMemory(),
        observeMutationReplay: (observation) => {
          observations.push(observation);
          if (observation.operationId !== undefined && observation.disposition === "execute")
            operations.push(observation.operationId);
        },
        observeProgress: (observation) => {
          progress.push(observation);
        },
      };
      // Undefined test overrides mean omit an optional dependency, never bypass its guard.
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) Reflect.deleteProperty(serverOptions, key);
        else Reflect.set(serverOptions, key, value);
      }
      const handle = createOmniCodexMcpServer(serverOptions);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "owner-status-test", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      connections.push({ client, handle });
      await client.listTools();
      return { client, handle };
    },
    async close() {
      for (const connection of connections.reverse()) {
        await connection.client.close();
        await connection.handle.server.close();
      }
    },
  };
}

describe("first-class owner-only status tool", () => {
  it("returns request-local mutation diagnostics without inventing an operation for ambiguity", async () => {
    const fixture = rig({ failNative: true });
    try {
      const first = await fixture.connect();
      const failure = await first.client.callTool(originalRequest);
      const operationId = fixture.operations[0];
      expect(failure.structuredContent).toMatchObject({
        mutationRecovery: {
          requestId: expect.stringMatching(/^[a-f0-9]{32}$/u),
          operationId,
          statusArguments: { operationId },
          statusTool: LEGACY_MUTATION_STATUS_TOOL,
        },
      });
      const failureRecovery = (
        failure.structuredContent as {
          mutationRecovery: {
            statusTool: string;
            statusArguments: { operationId: string };
            statusInstructions: string;
          };
        }
      ).mutationRecovery;
      expect(failureRecovery.statusInstructions).toContain(
        "Do not pass the whole mutationRecovery object as arguments",
      );
      const advertisedStatus = await first.client.callTool({
        name: failureRecovery.statusTool,
        arguments: failureRecovery.statusArguments,
      });
      expect(advertisedStatus.isError).not.toBe(true);
      expect(advertisedStatus.structuredContent).toMatchObject({
        matches: [{ operationId, state: "outcome_unknown" }],
        replayPermittedByThisRead: false,
      });
      const invalidStatus = await first.client.callTool({
        name: failureRecovery.statusTool,
        arguments: failureRecovery,
      });
      expect(invalidStatus.isError).toBe(true);
      expect(JSON.stringify(invalidStatus.content)).toContain("LEGACY_STATUS_ARGUMENTS_INVALID");
      const otherOwner = await fixture.connect("owner-b");
      const deniedStatus = await otherOwner.client.callTool({
        name: failureRecovery.statusTool,
        arguments: failureRecovery.statusArguments,
      });
      expect(deniedStatus.structuredContent).toMatchObject({
        outcome: "not_found_or_not_owned",
        matchCount: 0,
        replayPermittedByThisRead: false,
      });
      const second = await fixture.connect();
      const blocked = await second.client.callTool(originalRequest);
      const recovery = (blocked.structuredContent as Record<string, unknown>).mutationRecovery;
      expect(recovery).toEqual({
        requestId: expect.stringMatching(/^[a-f0-9]{32}$/u),
        statusTool: LEGACY_MUTATION_STATUS_TOOL,
        statusInstructions: expect.stringContaining("No operationId was allocated"),
      });
      expect(JSON.stringify(blocked.content)).toContain("mutationRecovery");
      expect(JSON.stringify(blocked)).not.toContain(operationId as string);
      expect(JSON.stringify(recovery)).not.toContain("synthetic-action");
      expect(fixture.nativeCalls).toHaveLength(1);
      expect(fixture.observations.filter((item) => item.disposition === "dispatch")).toHaveLength(
        1,
      );
      expect(
        fixture.observations.filter((item) => item.disposition === "native_settled"),
      ).toHaveLength(1);
      expect(
        fixture.observations.find((item) => item.disposition === "native_settled"),
      ).toMatchObject({
        observedAtUnixMs: expect.any(Number),
        nativeDispatchStarted: true,
        requestSignalAborted: false,
      });
      expect(JSON.stringify(fixture.observations)).not.toContain("synthetic-action");
      expect(JSON.stringify(fixture.observations)).not.toContain("synthetic-dispatch-failed");
      const status = await second.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "outcome_unknown" }],
        replayPermittedByThisRead: false,
      });
    } finally {
      await fixture.close();
    }
  });

  it.each(["argument", "omnicodexMeta", "openAiMeta"] as const)(
    "preserves the approved %s mutation identity contract without logging its value",
    async (source) => {
      const fixture = rig();
      const id = "10000000-0000-4000-8000-000000000991";
      try {
        const first = await fixture.connect();
        const request = {
          ...originalRequest,
          arguments: {
            ...originalRequest.arguments,
            ...(source === "argument" ? { omnicodexInvocationId: id } : {}),
          },
          ...(source === "argument"
            ? {}
            : {
                _meta: {
                  [source === "omnicodexMeta"
                    ? "omnicodex/invocationId"
                    : "openai/toolInvocationId"]: id,
                },
              }),
        };
        expect((await first.client.callTool(request)).isError).not.toBe(true);
        expect(fixture.observations[0]).toMatchObject({
          identityMode: "explicit",
          disposition: "execute",
        });
        expect(fixture.progress[0]?.invocationIdentityInputs).toEqual({
          argument: source === "argument",
          omnicodexMeta: source === "omnicodexMeta",
          openAiMeta: source === "openAiMeta",
        });
        expect(fixture.nativeCalls[0]).toEqual(originalRequest.arguments);
        expect(JSON.stringify(fixture.progress)).not.toContain(id);
        expect(JSON.stringify(fixture.observations)).not.toContain(id);
      } finally {
        await fixture.close();
      }
    },
  );

  it("does not promote ordinary session or request metadata into a mutation identity", async () => {
    const fixture = rig({ failNative: true });
    try {
      const first = await fixture.connect();
      await first.client.callTool({
        ...originalRequest,
        _meta: {
          "openai/session": "synthetic-session-private",
          requestId: "synthetic-request-private",
        },
      });
      expect(fixture.progress[0]?.invocationIdentityInputs).toEqual({
        argument: false,
        omnicodexMeta: false,
        openAiMeta: false,
      });
      expect(fixture.observations[0]).toMatchObject({
        identityMode: "legacy",
        disposition: "execute",
        invocationIdentityInputs: { argument: false, omnicodexMeta: false, openAiMeta: false },
      });
      expect(JSON.stringify(fixture.observations)).not.toContain("synthetic-session-private");
      expect(JSON.stringify(fixture.observations)).not.toContain("synthetic-request-private");
    } finally {
      await fixture.close();
    }
  });

  it("reads an active cohort immediately without joining or waiting on its native operation", async () => {
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = rig({
      holdNative: async () => {
        started();
        await held;
      },
    });
    try {
      const first = await fixture.connect();
      const original = first.client.callTool(originalRequest);
      await dispatched;
      const second = await fixture.connect();
      const result = await second.client.callTool(
        { name: LEGACY_MUTATION_STATUS_TOOL, arguments: { operationId: fixture.operations[0] } },
        undefined,
        { timeout: 1000 },
      );
      expect(result.structuredContent).toMatchObject({
        matches: [{ state: "in_flight" }],
        replayPermittedByThisRead: false,
      });
      expect(fixture.nativeCalls).toHaveLength(1);
      release();
      await original;
    } finally {
      release();
      await fixture.close();
    }
  });

  it("does not fabricate a historical argument match when the current target contract changed", async () => {
    const original = rig({ failNative: true });
    const changed = rig({ changedContract: true, coordinator: original.coordinator });
    try {
      const first = await original.connect();
      await first.client.callTool(originalRequest);
      const reader = await changed.connect();
      const result = await reader.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { request: requestSelector },
      });
      expect(result.structuredContent).toMatchObject({
        outcome: "not_found_or_not_owned",
        historicalActionLink: "unavailable",
        matches: [],
        selectionBasis: "exact_semantics_under_current_contract",
      });
      const status = await reader.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: original.operations[0] },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "outcome_unknown" }],
        historicalActionLink: "unavailable",
      });
      expect(changed.nativeCalls).toHaveLength(0);
    } finally {
      await changed.close();
      await original.close();
    }
  });

  it("links exact synthetic request semantics to UNKNOWN without redispatch or guard release", async () => {
    const fixture = rig({ failNative: true });
    try {
      const first = await fixture.connect();
      expect((await first.client.callTool(originalRequest)).isError).toBe(true);
      expect(fixture.nativeCalls).toHaveLength(1);
      const operationId = fixture.operations[0];
      expect(operationId).toEqual(expect.any(String));
      const second = await fixture.connect();
      const response = await second.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { request: requestSelector },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        outcome: "matched",
        historicalActionLink: "semantic_candidates_only",
        originalRequestIdentity: "not_retained",
        replayPermittedByThisRead: false,
        matches: [{ operationId, state: "outcome_unknown", code: "NATIVE_DISPATCH_FAILED" }],
      });
      const exactOperation = await second.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId, request: requestSelector },
      });
      expect(exactOperation.structuredContent).toMatchObject({
        selectionBasis: "operation_id_and_exact_semantics_under_current_contract",
        matchCount: 1,
      });
      const unavailable = await second.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: {
          operationId,
          request: { ...requestSelector, arguments: { value: "different-synthetic-action" } },
        },
      });
      expect(unavailable.structuredContent).toMatchObject({
        outcome: "not_found_or_not_owned",
        matches: [],
      });
      const blocked = await second.client.callTool(originalRequest);
      expect(JSON.stringify(blocked)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
      expect(fixture.nativeCalls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("does not expose another execution owner's operation or semantic matches", async () => {
    const fixture = rig({ failNative: true });
    try {
      const owner = await fixture.connect();
      await owner.client.callTool(originalRequest);
      const foreign = await fixture.connect("owner-b");
      for (const args of [{ operationId: fixture.operations[0] }, { request: requestSelector }]) {
        const response = await foreign.client.callTool({
          name: LEGACY_MUTATION_STATUS_TOOL,
          arguments: args,
        });
        expect(response.structuredContent).toMatchObject({
          outcome: "not_found_or_not_owned",
          matchCount: 0,
          matches: [],
        });
        expect(JSON.stringify(response)).not.toContain(fixture.operations[0]);
      }
      expect(fixture.nativeCalls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("does not resolve or return session handles, continuation tokens or stored result contents", async () => {
    const fixture = rig();
    try {
      const first = await fixture.connect();
      await first.client.callTool(originalRequest);
      const resolveBinding = vi.fn(async () => {
        throw new Error("synthetic-continuation-token");
      });
      const protectResult = vi.fn(async () => {
        throw new Error("synthetic-result-wrapper-secret");
      });
      const second = await fixture.connect("owner-a", {
        resolveDurableWorkSessionBinding: resolveBinding,
        protectResult,
      });
      const result = await second.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: fixture.operations[0] },
      });
      expect(result.structuredContent).toMatchObject({
        matches: [{ state: "completed", completedResultRetained: true }],
        historicalActionLink: "unavailable",
      });
      expect(resolveBinding).not.toHaveBeenCalled();
      expect(protectResult).not.toHaveBeenCalled();
      for (const secret of [
        "synthetic-result-secret",
        "synthetic-continuation-token",
        "continuationToken",
        "workSessionBinding",
        "synthetic-result-wrapper-secret",
      ])
        expect(JSON.stringify(result)).not.toContain(secret);
      expect(fixture.nativeCalls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("advertises the supported read route in full and bounded action catalogs and native search", async () => {
    const fixture = rig();
    try {
      for (const overrides of [
        {},
        { actionCatalogByteBudget: OMNICODEX_CHATGPT_ACTION_CATALOG_BYTE_BUDGET },
      ]) {
        const connection = await fixture.connect("owner-a", overrides);
        const tools = (await connection.client.listTools()).tools;
        expect(
          tools.find((tool) => tool.name === LEGACY_MUTATION_STATUS_TOOL)?.inputSchema,
        ).toMatchObject({
          additionalProperties: false,
          anyOf: [{ required: ["operationId"] }, { required: ["request"] }],
        });
        expect(await connection.handle.classifyToolCall(LEGACY_MUTATION_STATUS_TOOL, {})).toBe(
          "non_model",
        );
        const search = await connection.client.callTool({
          name: "search_native_tools",
          arguments: { query: LEGACY_MUTATION_STATUS_TOOL, includeSchemas: true },
        });
        expect(search.isError).not.toBe(true);
        expect(JSON.stringify(search)).toContain(LEGACY_MUTATION_STATUS_TOOL);
        expect(search.structuredContent).toMatchObject({
          tools: [
            {
              executeWith: "call_native_tool",
              executeArguments: { name: LEGACY_MUTATION_STATUS_TOOL },
            },
          ],
        });
      }
      expect(fixture.nativeCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("uses the existing callable router for owner-only status without mutation or result wrappers", async () => {
    const fixture = rig({ failNative: true });
    try {
      const original = await fixture.connect();
      await original.client.callTool(originalRequest);
      const operationId = fixture.operations[0];
      expect(operationId).toBeDefined();
      const resolveBinding = vi.fn(() => {
        throw new Error("synthetic-private-continuation-token");
      });
      const protectResult = vi.fn(() => {
        throw new Error("synthetic-private-result-wrapper");
      });
      const acquire = vi.spyOn(fixture.coordinator, "acquire");
      const owner = await fixture.connect("owner-a", {
        resolveDurableWorkSessionBinding: resolveBinding,
        protectResult,
      });
      const search = await original.client.callTool({
        name: "search_native_tools",
        arguments: { query: LEGACY_MUTATION_STATUS_TOOL, includeSchemas: true },
      });
      const revision = (search.structuredContent as { catalogRevision: string }).catalogRevision;
      resolveBinding.mockClear();
      protectResult.mockClear();
      const args = {
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId, limit: 1 },
        expectedCatalogRevision: revision,
      };
      const result = await owner.client.callTool({ name: "call_native_tool", arguments: args });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        outcome: "matched",
        historicalActionLink: "unavailable",
        replayPermittedByThisRead: false,
        matches: [{ operationId, state: "outcome_unknown" }],
      });
      expect(resolveBinding).not.toHaveBeenCalled();
      expect(protectResult).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(fixture.nativeCalls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toMatch(
        /continuationToken|workSessionBinding|synthetic-private/,
      );

      const foreign = await fixture.connect("owner-b");
      expect(
        (await foreign.client.callTool({ name: "call_native_tool", arguments: args }))
          .structuredContent,
      ).toMatchObject({ outcome: "not_found_or_not_owned", matches: [] });
      for (const invalid of [
        { ...args, query: LEGACY_MUTATION_STATUS_TOOL },
        { ...args, expectedCatalogRevision: "synthetic-obsolete-revision" },
        { ...args, arguments: { operationId, owner: "owner-a" } },
      ]) {
        expect(
          (await owner.client.callTool({ name: "call_native_tool", arguments: invalid })).isError,
        ).toBe(true);
      }
      expect(acquire).not.toHaveBeenCalled();
      expect(fixture.nativeCalls).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("fails closed when there is no authenticated owner", async () => {
    const fixture = rig();
    try {
      await expect(
        fixture.connect("owner-a", {
          authorizationBinding: undefined,
          mutationReplayStore: undefined,
        }),
      ).rejects.toThrow("Legacy mutation coordination requires an authorization binding");
      expect(fixture.nativeCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("reports unavailable if the authenticated server has no legacy coordinator", async () => {
    const fixture = rig();
    try {
      const connection = await fixture.connect("owner-a", { legacyMutationCoordinator: undefined });
      const result = await connection.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: "00000000-0000-5000-8000-000000000000" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("LEGACY_STATUS_AUTHENTICATED_COORDINATOR_REQUIRED");
      expect(fixture.nativeCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it("rejects owner overrides and never echoes arbitrary coordinator error text", async () => {
    const fixture = rig();
    try {
      const connection = await fixture.connect();
      const forged = await connection.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: "00000000-0000-5000-8000-000000000000", ownerBinding: "owner-b" },
      });
      expect(forged.isError).toBe(true);
      expect(JSON.stringify(forged)).not.toContain("owner-b");
      vi.spyOn(fixture.coordinator, "readStatus").mockRejectedValueOnce(
        new Error("private synthetic secret continuationToken"),
      );
      const unavailable = await connection.client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: "00000000-0000-5000-8000-000000000000" },
      });
      expect(JSON.stringify(unavailable)).toContain("LEGACY_STATUS_QUERY_UNAVAILABLE");
      expect(JSON.stringify(unavailable)).not.toContain("private synthetic secret");
      expect(fixture.nativeCalls).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
});
