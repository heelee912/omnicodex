import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";
import { DurableWorkSessionStore } from "../src/infrastructure/mcp/durable-work-session-store.js";
import { OwnerBoundResourceStore } from "../src/infrastructure/mcp/owner-bound-resource-store.js";
import { PROTECTED_RESULT_HANDLE_PREFIX } from "../src/infrastructure/mcp/protected-result-mapper.js";
import { StreamableHttpGateway } from "../src/infrastructure/mcp/streamable-http-gateway.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, readFile: vi.fn(original.readFile) };
});

it("delivers a native timeout receipt before the HTTP client deadline despite unrelated slow manifests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-receipt-timeout-"));
  const spool = join(directory, "results");
  const owner = {
    issuer: "https://fixture.invalid/",
    subject: "fixture-owner",
    clientId: "fixture-client",
    resource: "https://fixture.invalid/native/full",
  };
  const store = new OwnerBoundResourceStore({ dataDirectory: spool });
  const slowPaths = new Set<string>();
  for (let index = 0; index < 40; index += 1) {
    const entry = await store.put({
      owner,
      sessionId: "U".repeat(43),
      mimeType: "text/plain",
      bytes: Buffer.from(`unrelated-fixture-${index}`),
    });
    slowPaths.add(join(spool, entry.id, "manifest.json"));
  }
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let delayEnabled = true;
  let activeReads = 0;
  let maximumActiveReads = 0;
  vi.mocked(readFile).mockImplementation((async (...args: Parameters<typeof readFile>) => {
    if (delayEnabled && typeof args[0] === "string" && slowPaths.has(args[0])) {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return await original.readFile(...args);
      } finally {
        activeReads -= 1;
      }
    }
    return original.readFile(...args);
  }) as typeof readFile);
  let nativeCalls = 0;
  let resultPrepared = false;
  const workSessions = await DurableWorkSessionStore.open({
    dataDirectory: join(directory, "work-sessions"),
  });
  const gateway = new StreamableHttpGateway({
    appServer: {
      request: async <T>(method: string): Promise<T> => {
        if (method === "mcpServerStatus/list") return { data: [], nextCursor: null } as T;
        throw new Error("Unexpected fixture dispatch");
      },
    },
    browserNativeExecutor: {
      call: async () => {
        nativeCalls += 1;
        return {
          isError: true,
          content: [{ type: "text", text: "TimeoutError: synthetic screenshot timeout" }],
        };
      },
    },
    host: "127.0.0.1",
    port: 0,
    path: "/native",
    fullPath: "/native/full",
    resourceStore: store,
    durableWorkSessionStore: workSessions,
    observeResultDelivery: () => {
      resultPrepared = true;
    },
    protectedResourceMetadata: {
      resource: "https://fixture.invalid/native",
      authorization_servers: ["https://fixture.invalid/"],
      scopes_supported: ["omnicodex:full"],
      bearer_methods_supported: ["header"],
    },
    authorize: (request) =>
      request.headers.authorization !== "Bearer fixture-only"
        ? { ok: false, status: 401, message: "Unauthorized" }
        : {
            ok: true,
            identity: owner,
            authInfo: {
              token: "fixture-only",
              clientId: owner.clientId,
              scopes: ["omnicodex:full"],
              resource: new URL(owner.resource),
              extra: { issuer: owner.issuer, subject: owner.subject },
            },
          },
  });
  const client = new Client(
    { name: "receipt-timeout-fixture", version: "1" },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  try {
    const address = await gateway.start();
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(address.fullPath, `http://${address.host}:${address.port}`),
        { requestInit: { headers: { Authorization: "Bearer fixture-only" } } },
      ),
    );
    const result = await client.callTool(
      {
        name: "chrome__control_chrome",
        arguments: { operation: "exec", code: "return 'synthetic-only';" },
        _meta: { "openai/session": "approved-own-fixture-session" },
      },
      { signal: AbortSignal.timeout(1_500) },
    );
    expect(result.isError).toBe(true);
    const guides = result.content.filter(
      (item) => item.type === "text" && item.text.startsWith(PROTECTED_RESULT_HANDLE_PREFIX),
    );
    expect(guides).toHaveLength(1);
    const item = guides[0];
    if (item?.type !== "text") throw new Error("Fixture guide missing");
    const guide = JSON.parse(item.text.slice(PROTECTED_RESULT_HANDLE_PREFIX.length));
    const ownRead = await client.callTool({
      name: guide.retrievalTool,
      arguments: guide.readArguments,
      _meta: { "openai/session": "approved-own-fixture-session" },
    });
    expect(ownRead.structuredContent).toMatchObject({
      snapshotIntegrity: "verified",
      nextOffset: null,
      digest: guide.digest,
    });
    const chunk = (ownRead.structuredContent as Record<string, unknown> | undefined)?.chunk;
    expect(typeof chunk).toBe("string");
    expect(createHash("sha256").update(String(chunk)).digest("base64url")).toBe(guide.digest);
    expect(JSON.parse(String(chunk)).content[0].text).toBe(
      "TimeoutError: synthetic screenshot timeout",
    );
    const denied = await client.callTool({
      name: guide.retrievalTool,
      arguments: guide.readArguments,
      _meta: { "openai/session": "other-own-fixture-session" },
    });
    expect(denied.isError).toBe(true);
    expect(
      (denied.structuredContent as Record<string, unknown> | undefined)?.chunk,
    ).toBeUndefined();
    expect(maximumActiveReads).toBeGreaterThan(1);
    expect(maximumActiveReads).toBeLessThanOrEqual(32);
    expect(nativeCalls).toBe(1);
  } finally {
    // Release only the fixture's artificial delay after a failed client deadline.
    delayEnabled = false;
    if (nativeCalls > 0)
      await vi.waitFor(() => expect(resultPrepared).toBe(true), { timeout: 5_000 });
    await client.close();
    await gateway.stop();
    vi.mocked(readFile).mockImplementation(original.readFile);
    await rm(directory, { recursive: true, force: true });
  }
});
