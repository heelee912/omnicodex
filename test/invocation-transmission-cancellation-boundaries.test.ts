import { request as requestHttp } from "node:http";
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

function fixture(compat = false) {
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
        resource: compat
          ? "https://synthetic.example/native"
          : "https://synthetic.example/native/full",
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

async function connect(gateway: StreamableHttpGateway, compat = false) {
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
      new URL(`http://${address.host}:${address.port}${compat ? address.path : address.fullPath}`),
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

describe("non-identifying invocation transmission and cancellation boundaries", () => {
  it.each(["direct", "facade"] as const)(
    "preserves discovered execution identity via %s",
    async (route) => {
      const f = fixture();
      const client = await connect(f.gateway);
      try {
        const search = await client.callTool({
          name: "search_native_tools",
          arguments: { query: mutation.name, limit: 1 },
        });
        const match = (
          search.structuredContent as {
            tools: Array<{
              executionInputSchema: object;
              executeWith: string;
              catalogRevision?: string;
            }>;
          }
        ).tools[0];
        if (match === undefined) throw new Error("Synthetic discovery match missing");
        const args = {
          ...mutation.arguments,
          omnicodexInvocationId: "synthetic-intent-preserved-0001",
        };
        expect(new Ajv({ strict: false }).compile(match.executionInputSchema)(args)).toBe(true);
        f.release.resolve();
        const request =
          route === "direct"
            ? { name: match.executeWith, arguments: args }
            : {
                name: "call_native_tool",
                arguments: {
                  name: mutation.name,
                  arguments: mutation.arguments,
                  omnicodexInvocationId: args.omnicodexInvocationId,
                },
              };
        expect((await client.callTool(request)).isError).not.toBe(true);
        const admission = f.observations.find((o) => o.disposition === "execute");
        expect(admission).toMatchObject({ identityMode: "explicit" });
        expect(
          f.progress.find((o) => o.phase === "started" && o.mcpToolName === request.name)
            ?.invocationIdentityInputs,
        ).toEqual({ argument: true, omnicodexMeta: false, openAiMeta: false });
        expect((await client.callTool(request)).isError).not.toBe(true);
        expect(f.nativeArguments).toHaveLength(1);
        expect(JSON.stringify(f.nativeArguments)).not.toContain("omnicodexInvocationId");
        expectPrivateValuesAbsent([f.observations, f.requests, f.progress]);
      } finally {
        f.release.resolve();
        await client.close();
        await f.gateway.stop();
      }
    },
  );

  it("publishes wrapper placement in compat search and preserves the resulting identity", async () => {
    const f = fixture(true);
    const client = await connect(f.gateway, true);
    try {
      const search = await client.callTool({
        name: "search_native_tools",
        arguments: { query: mutation.name, limit: 1 },
      });
      const match = (
        search.structuredContent as {
          tools: Array<{ executeWith: string; executeArguments: Record<string, unknown> }>;
        }
      ).tools[0];
      if (match === undefined) throw new Error("Synthetic compat discovery match missing");
      expect(match.executeWith).toBe("call_native_tool");
      expect(match.executeArguments.omnicodexInvocationId).toEqual(
        expect.stringContaining("wrapper"),
      );
      expect(match.executeArguments.arguments).toBe(
        "Supply target arguments matching nativeTool.inputSchema here.",
      );
      const request = {
        name: match.executeWith,
        arguments: {
          ...match.executeArguments,
          arguments: mutation.arguments,
          omnicodexInvocationId: "synthetic-compat-intent-0001",
        },
      };
      f.release.resolve();
      expect((await client.callTool(request)).isError).not.toBe(true);
      expect(f.observations.find((o) => o.disposition === "execute")).toMatchObject({
        identityMode: "explicit",
      });
      expect((await client.callTool(request)).isError).not.toBe(true);
      expect(f.nativeArguments).toHaveLength(1);
      expect(JSON.stringify(f.nativeArguments)).not.toContain("omnicodexInvocationId");
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });

  it("characterizes an identity nested inside facade target arguments as native payload, not wrapper identity", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    try {
      const nested = {
        ...mutation.arguments,
        omnicodexInvocationId: "synthetic-nested-payload-0001",
      };
      f.release.resolve();
      expect(
        (
          await client.callTool({
            name: "call_native_tool",
            arguments: { name: mutation.name, arguments: nested },
          })
        ).isError,
      ).not.toBe(true);
      expect(f.observations.find((o) => o.disposition === "execute")).toMatchObject({
        identityMode: "legacy",
      });
      expect(JSON.stringify(f.nativeArguments)).toContain("omnicodexInvocationId");
      expect(
        f.progress.find((o) => o.phase === "started" && o.mcpToolName === "call_native_tool")
          ?.invocationIdentityInputs,
      ).toEqual({ argument: false, omnicodexMeta: false, openAiMeta: false });
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });

  it("does not synthesize identity merely because discovery advertised it", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    try {
      const search = await client.callTool({
        name: "search_native_tools",
        arguments: { query: mutation.name, limit: 1 },
      });
      expect(JSON.stringify(search.structuredContent)).toContain("omnicodexInvocationId");
      f.release.resolve();
      expect((await client.callTool(mutation)).isError).not.toBe(true);
      expect(f.observations.find((o) => o.disposition === "execute")).toMatchObject({
        identityMode: "legacy",
        invocationIdentityInputs: { argument: false, omnicodexMeta: false, openAiMeta: false },
      });
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });

  it("keeps a normal 11 second request connected and completes without UNKNOWN", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    try {
      const pending = client.callTool(mutation);
      await f.started.promise;
      const admission = f.observations.find((o) => o.disposition === "execute");
      const dispatchAt = Date.now();
      await new Promise<void>((done) => setTimeout(done, 11_000));
      expect(Date.now() - dispatchAt).toBeGreaterThanOrEqual(10_900);
      expect(f.nativeSignals[0]?.aborted).toBe(false);
      expect(f.requests.find((r) => r.correlationId === admission?.correlationId)).toBeUndefined();
      expect(f.observations.some((o) => o.disposition === "request_signal_aborted")).toBe(false);
      f.release.resolve();
      expect((await pending).isError).not.toBe(true);
      await vi.waitFor(() =>
        expect(f.requests.find((r) => r.correlationId === admission?.correlationId)).toMatchObject({
          status: 200,
          responseTermination: "finish",
        }),
      );
      const status = await client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: admission?.operationId },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "completed" }],
        replayPermittedByThisRead: false,
      });
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  }, 20_000);

  it("reproduces a caller deadline closing the HTTP response after about 9 seconds", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    try {
      const since = Date.now();
      const pending = client.callTool(mutation, { timeout: 9_000 });
      const rejected = expect(pending).rejects.toThrow();
      await f.started.promise;
      const admission = f.observations.find((o) => o.disposition === "execute");
      await rejected;
      expect(Date.now() - since).toBeGreaterThanOrEqual(8_900);
      await vi.waitFor(() =>
        expect(f.requests.find((r) => r.correlationId === admission?.correlationId)).toMatchObject({
          status: 0,
          responseTermination: "close_before_finish",
        }),
      );
      await vi.waitFor(() =>
        expect(
          f.observations.find((o) => o.disposition === "request_signal_aborted"),
        ).toMatchObject({
          cancellationSource: "sdk_request_signal",
          nativeDispatchStarted: true,
          requestSignalAborted: true,
        }),
      );
      const status = await client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: admission?.operationId },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "outcome_unknown", code: "NATIVE_DISPATCH_FAILED" }],
        replayPermittedByThisRead: false,
      });
      expect(f.nativeSignals).toHaveLength(1);
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  }, 20_000);

  it("distinguishes a native completion deadline from caller connection loss", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    try {
      const result = await client.callTool({
        name: "call_native_tool",
        arguments: { name: mutation.name, arguments: mutation.arguments, timeoutMs: 100 },
      });
      expect(result.isError).toBe(true);
      const admission = f.observations.find((o) => o.disposition === "execute");
      await vi.waitFor(() =>
        expect(f.requests.find((r) => r.correlationId === admission?.correlationId)).toMatchObject({
          status: 200,
          responseTermination: "finish",
        }),
      );
      expect(f.observations.some((o) => o.disposition === "request_signal_aborted")).toBe(false);
      expect(f.observations.find((o) => o.disposition === "native_settled")).toMatchObject({
        nativeDispatchStarted: true,
        requestSignalAborted: false,
      });
      const status = await client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: admission?.operationId },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "outcome_unknown", code: "NATIVE_DISPATCH_FAILED" }],
        replayPermittedByThisRead: false,
      });
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });

  it("records bare TCP response loss as SDK cancellation without a protocol cancel notification", async () => {
    const f = fixture();
    const client = await connect(f.gateway);
    try {
      const address = await f.gateway.start();
      const wire = requestHttp(
        new URL(`http://${address.host}:${address.port}${address.fullPath}`),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer synthetic-owner",
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": "2026-07-28",
            "MCP-Method": "tools/call",
            "MCP-Name": mutation.name,
          },
        },
        (response) => response.resume(),
      );
      wire.on("error", () => undefined);
      wire.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 9999,
          method: "tools/call",
          params: {
            ...mutation,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "synthetic-socket", version: "1" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      );
      await vi.waitFor(() => expect(f.nativeSignals).toHaveLength(1));
      const admission = f.observations.find((o) => o.disposition === "execute");
      wire.destroy();
      await vi.waitFor(() =>
        expect(f.requests.find((r) => r.correlationId === admission?.correlationId)).toMatchObject({
          status: 0,
          responseTermination: "close_before_finish",
        }),
      );
      await vi.waitFor(() =>
        expect(
          f.observations.find((o) => o.disposition === "request_signal_aborted"),
        ).toMatchObject({
          cancellationSource: "sdk_request_signal",
          nativeDispatchStarted: true,
          requestSignalAborted: true,
        }),
      );
      const status = await client.callTool({
        name: LEGACY_MUTATION_STATUS_TOOL,
        arguments: { operationId: admission?.operationId },
      });
      expect(status.structuredContent).toMatchObject({
        matches: [{ state: "outcome_unknown", code: "NATIVE_DISPATCH_FAILED" }],
        replayPermittedByThisRead: false,
      });
    } finally {
      f.release.resolve();
      await client.close();
      await f.gateway.stop();
    }
  });
});
