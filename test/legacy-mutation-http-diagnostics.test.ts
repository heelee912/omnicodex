import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Ajv } from "ajv";
import { describe, expect, it, vi } from "vitest";
import { CodexAppHostToolExecutor } from "../src/application/codex-app-host-tool-executor.js";
import { LEGACY_MUTATION_STATUS_TOOL } from "../src/infrastructure/mcp/legacy-mutation-status-tool.js";
import type {
  BrowserNativeToolExecutor,
  McpMutationReplayObservation,
  McpProgressObservation,
} from "../src/infrastructure/mcp/omnicodex-mcp-server.js";
import {
  StreamableHttpGateway,
  type StreamableHttpGatewayRequestObservation,
} from "../src/infrastructure/mcp/streamable-http-gateway.js";

// A fake browser adapter only. No tab, browser runtime, account or company URL is accessed.
const mutation = {
  name: "chrome__control_chrome",
  arguments: { operation: "exec", code: "await syntheticMutation();" },
};

function fixture(failNative = false) {
  const started = deferred();
  const release = deferred();
  const observations: McpMutationReplayObservation[] = [];
  const requests: StreamableHttpGatewayRequestObservation[] = [];
  const progress: McpProgressObservation[] = [];
  const nativeSignals: Array<AbortSignal | undefined> = [];
  const nativeArguments: unknown[] = [];
  const appServer = {
    request: async <T>(method: string): Promise<T> => {
      if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
      throw new Error("unexpected synthetic App Server dispatch");
    },
  };
  const browserNativeExecutor: BrowserNativeToolExecutor = {
    async call(_args, context) {
      nativeArguments.push(_args);
      nativeSignals.push(context?.signal);
      started.resolve();
      await release.promise;
      if (failNative)
        return { isError: true, content: [{ type: "text", text: "synthetic-error" }] };
      return { content: [{ type: "text", text: "synthetic-mutation-finished" }] };
    },
  };
  const gateway = new StreamableHttpGateway({
    appServer,
    browserNativeExecutor,
    codexAppHostToolExecutor: new CodexAppHostToolExecutor(appServer),
    path: "/native",
    fullPath: "/native/full",
    protectedResourceMetadata: {
      resource: "https://synthetic.example/native",
      authorization_servers: ["https://synthetic.example/"],
      scopes_supported: ["omnicodex:full"],
      bearer_methods_supported: ["header"],
    },
    observeMcpRequest: (item) => {
      requests.push(item);
    },
    observeMutationReplay: (item) => {
      observations.push(item);
    },
    observeProgress: (item) => {
      progress.push(item);
    },
    authorize: (request) => {
      if (request.headers.authorization !== "Bearer synthetic-owner") {
        return { ok: false, status: 401, headers: {}, message: "Unauthorized" };
      }
      const identity = {
        issuer: "https://synthetic.example/",
        subject: "synthetic-private-subject",
        clientId: "synthetic-private-client",
        resource: "https://synthetic.example/native/full",
      };
      return {
        ok: true,
        identity,
        authInfo: {
          token: "synthetic-private-credential",
          clientId: identity.clientId,
          scopes: ["omnicodex:full"],
          resource: new URL(identity.resource),
        },
      };
    },
  });
  return {
    gateway,
    started,
    release,
    observations,
    requests,
    progress,
    nativeSignals,
    nativeArguments,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function connect(gateway: StreamableHttpGateway) {
  const address = await gateway.start();
  const client = new Client(
    { name: "synthetic-mutation-diagnostics", version: "1" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://${address.host}:${address.port}${address.fullPath}`),
      { requestInit: { headers: { Authorization: "Bearer synthetic-owner" } } },
    ),
  );
  return client;
}

function expectPrivateValuesAbsent(value: unknown) {
  for (const sentinel of [
    "synthetic-private-subject",
    "synthetic-private-client",
    "synthetic-private-credential",
    "synthetic-owner",
    "syntheticMutation()",
  ])
    expect(JSON.stringify(value)).not.toContain(sentinel);
}

describe("modern HTTP legacy mutation diagnostics", () => {
  it.each(["argument", "omnicodexMeta", "openAiMeta"] as const)(
    "retains the stable %s identity through the actual modern HTTP route",
    async (source) => {
      const f = fixture();
      const client = await connect(f.gateway);
      const id = "10000000-0000-4000-8000-000000000992";
      const request = {
        ...mutation,
        arguments: {
          ...mutation.arguments,
          ...(source === "argument" ? { omnicodexInvocationId: id } : {}),
        },
        ...(source === "argument"
          ? {}
          : {
              _meta: {
                [source === "omnicodexMeta" ? "omnicodex/invocationId" : "openai/toolInvocationId"]:
                  id,
              },
            }),
      };
      try {
        const listed = await client.listTools();
        const browserTool = listed.tools.find((item) => item.name === mutation.name);
        expect(browserTool?.inputSchema.properties).toHaveProperty("omnicodexInvocationId");
        expect(browserTool?.inputSchema.additionalProperties).toBe(false);
        const validate = new Ajv({ strict: false }).compile(browserTool?.inputSchema ?? {});
        expect(validate(request.arguments), JSON.stringify(validate.errors)).toBe(true);
        const search = await client.callTool({
          name: "search_native_tools",
          arguments: { query: mutation.name, limit: 1 },
        });
        const matches = (
          search.structuredContent as
            | {
                tools?: Array<{
                  nativeTool?: { inputSchema?: { properties?: Record<string, unknown> } };
                  executionInputSchema?: object;
                  executeWith?: string;
                }>;
              }
            | undefined
        )?.tools;
        expect(matches?.[0]?.nativeTool?.inputSchema?.properties).toHaveProperty("operation");
        expect(matches?.[0]?.nativeTool?.inputSchema?.properties).not.toHaveProperty(
          "omnicodexInvocationId",
        );
        expect(matches?.[0]?.executionInputSchema).toEqual(browserTool?.inputSchema);
        expect(matches?.[0]?.executeWith).toBe(mutation.name);
        const discoveredValidate = new Ajv({ strict: false }).compile(
          matches?.[0]?.executionInputSchema ?? {},
        );
        expect(discoveredValidate(request.arguments)).toBe(true);
        expect(discoveredValidate({ ...mutation.arguments, omnicodexInvocationId: "short" })).toBe(
          false,
        );
        const searchTool = listed.tools.find((item) => item.name === "search_native_tools");
        const validateSearchOutput = new Ajv({ strict: false }).compile(
          (searchTool?.outputSchema ?? {}) as object,
        );
        expect(
          validateSearchOutput(search.structuredContent),
          JSON.stringify(validateSearchOutput.errors),
        ).toBe(true);
        f.release.resolve();
        expect(
          (await client.callTool({ ...request, name: String(matches?.[0]?.executeWith) })).isError,
        ).not.toBe(true);
        const admission = f.observations.find((item) => item.disposition === "execute");
        expect(admission?.identityMode).toBe("explicit");
        const expectedInputs = {
          argument: source === "argument",
          omnicodexMeta: source === "omnicodexMeta",
          openAiMeta: source === "openAiMeta",
        };
        await vi.waitFor(() =>
          expect(
            f.requests.find((item) => item.correlationId === admission?.correlationId)
              ?.invocationIdentityInputs,
          ).toEqual(expectedInputs),
        );
        expect(
          f.progress.find((item) => item.phase === "started" && item.mcpToolName === mutation.name)
            ?.invocationIdentityInputs,
        ).toEqual(expectedInputs);
        expect((await client.callTool(request)).isError).not.toBe(true);
        expect(f.nativeSignals).toHaveLength(1);
        expect(JSON.stringify(f.nativeArguments)).not.toContain("omnicodexInvocationId");
        expect(JSON.stringify([f.requests, f.observations, f.progress])).not.toContain(id);
        expectPrivateValuesAbsent([f.requests, f.observations, f.progress]);
      } finally {
        f.release.resolve();
        await client.close();
        await f.gateway.stop();
      }
    },
  );

  it("keeps retransmission, independent new intent and conflicting identity distinct", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    const firstId = "10000000-0000-4000-8000-000000000994";
    const secondId = "10000000-0000-4000-8000-000000000995";
    const identified = (id: string) => ({
      ...mutation,
      arguments: { ...mutation.arguments, omnicodexInvocationId: id },
    });
    try {
      f.release.resolve();
      const listed = await client.listTools();
      const tool = listed.tools.find((item) => item.name === mutation.name);
      const validate = new Ajv({ strict: false }).compile(tool?.inputSchema ?? {});
      expect(validate(identified(firstId).arguments)).toBe(true);
      expect(validate({ ...mutation.arguments, omnicodexInvocationId: "short" })).toBe(false);
      expect(validate({ ...mutation.arguments, unsupportedIdentity: firstId })).toBe(false);
      expect((await client.callTool(identified(firstId))).isError).not.toBe(true);
      expect((await client.callTool(identified(firstId))).isError).not.toBe(true);
      expect(f.nativeSignals).toHaveLength(1);
      const changedPayload = await client.callTool({
        ...identified(firstId),
        arguments: {
          ...identified(firstId).arguments,
          code: "await differentSyntheticMutation();",
        },
      });
      expect(changedPayload.isError).toBe(true);
      expect(JSON.stringify(changedPayload)).toContain("MUTATION_IDEMPOTENCY_CONFLICT");
      const conflictingSources = await client.callTool({
        ...identified(firstId),
        _meta: { "omnicodex/invocationId": secondId },
      });
      expect(conflictingSources.isError).toBe(true);
      expect(f.nativeSignals).toHaveLength(1);
      expect((await client.callTool(identified(secondId))).isError).not.toBe(true);
      expect(f.nativeSignals).toHaveLength(2);
      const operations = f.observations
        .filter((item) => item.identityMode === "explicit" && item.disposition === "execute")
        .map((item) => item.operationId);
      expect(new Set(operations).size).toBe(2);
      expect(JSON.stringify(f.nativeArguments)).not.toContain("omnicodexInvocationId");
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });

  it("keeps a normal delayed mutation alive until its terminal HTTP response", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    try {
      const pending = client.callTool(mutation);
      await f.started.promise;
      await nextEventLoopTurn();
      await nextEventLoopTurn();
      const admission = f.observations.find((item) => item.disposition === "execute");
      expect(admission?.correlationId).toMatch(/^[a-f0-9]{32}$/u);
      expect(f.nativeSignals).toHaveLength(1);
      expect(f.nativeSignals[0]?.aborted).toBe(false);
      expect(f.requests.some((item) => item.correlationId === admission?.correlationId)).toBe(
        false,
      );
      expect(f.observations.some((item) => item.disposition === "request_signal_aborted")).toBe(
        false,
      );
      f.release.resolve();
      expect((await pending).isError).not.toBe(true);
      await vi.waitFor(() =>
        expect(
          f.requests.find((item) => item.correlationId === admission?.correlationId),
        ).toMatchObject({
          responseTermination: "finish",
          responseEndedAtUnixMs: expect.any(Number),
          status: 200,
        }),
      );
      const settled = f.observations.find((item) => item.disposition === "native_settled");
      const response = f.requests.find((item) => item.correlationId === admission?.correlationId);
      expect(settled).toMatchObject({ nativeDispatchStarted: true, requestSignalAborted: false });
      expect(response?.responseEndedAtUnixMs).toBeGreaterThanOrEqual(
        settled?.observedAtUnixMs as number,
      );
      expect(
        f.progress.find((item) => item.mcpToolName === mutation.name && item.phase === "started")
          ?.invocationIdentityInputs,
      ).toEqual({ argument: false, omnicodexMeta: false, openAiMeta: false });
      expect(response?.invocationIdentityInputs).toEqual({
        argument: false,
        omnicodexMeta: false,
        openAiMeta: false,
      });
      const status = await client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: admission?.operationId },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "completed" }],
        replayPermittedByThisRead: false,
      });
      expectPrivateValuesAbsent([f.observations, f.requests, f.progress]);
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });

  it("round trips advertised status arguments from an HTTP native error without another dispatch", async () => {
    const f = fixture(true);
    const client = await connect(f.gateway);
    try {
      f.release.resolve();
      const failure = await client.callTool(mutation);
      expect(failure.isError).toBe(true);
      const recovery = (
        failure.structuredContent as {
          mutationRecovery: {
            statusTool: string;
            statusArguments: { operationId: string };
            statusInstructions: string;
          };
        }
      ).mutationRecovery;
      const admission = f.observations.find((item) => item.disposition === "execute");
      expect(recovery.statusArguments).toEqual({ operationId: admission?.operationId });
      expect(recovery.statusInstructions).toContain(
        "Do not pass the whole mutationRecovery object as arguments",
      );
      const status = await client.callTool({
        name: recovery.statusTool,
        arguments: recovery.statusArguments,
      });
      expect(status.isError).not.toBe(true);
      expect(status.structuredContent).toMatchObject({
        outcome: "matched",
        matches: [{ operationId: admission?.operationId }],
        replayPermittedByThisRead: false,
      });
      expect(f.nativeSignals).toHaveLength(1);
      expect(f.observations.filter((item) => item.disposition === "dispatch")).toHaveLength(1);
      expectPrivateValuesAbsent([recovery, f.observations, f.requests, f.progress]);
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });

  it("records actual HTTP cancellation separately and preserves UNKNOWN and ambiguity", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    const controller = new AbortController();
    try {
      const pending = client.callTool(mutation, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow(/AbortError/u);
      await f.started.promise;
      const admission = f.observations.find((item) => item.disposition === "execute");
      controller.abort();
      await rejected;
      await vi.waitFor(() =>
        expect(
          f.observations.find((item) => item.disposition === "request_signal_aborted"),
        ).toMatchObject({
          cancellationSource: "sdk_request_signal",
          observedAtUnixMs: expect.any(Number),
          nativeDispatchStarted: true,
          requestSignalAborted: true,
        }),
      );
      await vi.waitFor(() =>
        expect(
          f.requests.find((item) => item.correlationId === admission?.correlationId),
        ).toMatchObject({
          responseTermination: "close_before_finish",
          responseEndedAtUnixMs: expect.any(Number),
          status: 0,
        }),
      );
      await vi.waitFor(() =>
        expect(f.observations.some((item) => item.disposition === "native_settled")).toBe(true),
      );
      const status = await client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: admission?.operationId },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "outcome_unknown", code: "NATIVE_DISPATCH_FAILED" }],
        replayPermittedByThisRead: false,
      });
      const blocked = await client.callTool(mutation);
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
      expect(blocked.structuredContent).toMatchObject({
        mutationRecovery: {
          requestId: expect.stringMatching(/^[a-f0-9]{32}$/u),
          statusTool: LEGACY_MUTATION_STATUS_TOOL,
        },
      });
      expect(
        (blocked.structuredContent as Record<string, { operationId?: string }>).mutationRecovery
          ?.operationId,
      ).toBeUndefined();
      expect(
        (blocked.structuredContent as Record<string, { statusArguments?: unknown }>)
          .mutationRecovery?.statusArguments,
      ).toBeUndefined();
      expect(f.nativeSignals).toHaveLength(1);
      expect(f.observations.filter((item) => item.disposition === "dispatch")).toHaveLength(1);
      // Release the fake physical call; a caller cancellation did not prove it had no effect.
      f.release.resolve();
      await nextEventLoopTurn();
      const reminted = await client.callTool({
        ...mutation,
        arguments: {
          ...mutation.arguments,
          omnicodexInvocationId: "10000000-0000-4000-8000-000000000993",
        },
      });
      expect(reminted.isError).toBe(true);
      expect(JSON.stringify(reminted)).toContain("AMBIGUOUS_LEGACY_MUTATION_COHORT");
      expect(f.nativeSignals).toHaveLength(1);
      const unchanged = await client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: admission?.operationId },
      });
      expect(unchanged.structuredContent).toEqual(status.structuredContent);
      expectPrivateValuesAbsent([f.observations, f.requests, f.progress]);
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });
});
