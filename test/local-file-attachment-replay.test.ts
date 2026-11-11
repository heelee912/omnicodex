import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { MutationReplayStore } from "../src/infrastructure/mcp/mutation-replay-store.js";
import {
  createOmniCodexMcpServer,
  OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
} from "../src/infrastructure/mcp/omnicodex-mcp-server.js";

describe("local attachment approval replay", () => {
  it("replays the original snapshot across changed traces and restart while new requests read current bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-attachment-replay-"));
    const path = join(directory, "file.txt");
    const snapshotPath = join(directory, "replay.json");
    const restartedPath = join(directory, "restarted.json");
    const connections: {
      client: Client;
      server: ReturnType<typeof createOmniCodexMcpServer>["server"];
    }[] = [];
    let reads = 0;
    let trace = 0;
    const connect = async (store: MutationReplayStore, owner = "owner", session = "chat-a") => {
      const handle = createOmniCodexMcpServer({
        appServer: { request: async <T>(): Promise<T> => ({ data: [], nextCursor: null }) as T },
        surface: "full",
        authorizationBinding: owner,
        mutationReplayStore: store,
        resolveRequestAttribution: () => ({
          principalBindingSha256: owner,
          jsonRpcIdHmac: "reused-jsonrpc-id",
          transportIdentityDigests: [
            { name: "header:traceparent-trace-id", valueHmac: `trace-${++trace}` },
            { name: "meta:openai/session", valueHmac: session },
          ],
        }),
        resolveDurableWorkSessionBinding: () => ({
          workSessionBinding: session,
          directGoalClaimantBinding: session,
          directJobOwnerBinding: session,
          continuationToken: "test-continuation",
          journalCursor: "test-cursor",
        }),
        materializeLocalFile: async (requestedPath) => {
          reads += 1;
          const bytes = await readFile(requestedPath);
          const digest = createHash("sha256").update(bytes).digest("hex");
          return {
            content: [
              {
                type: "resource_link",
                name: "file.txt",
                uri: `https://example.test/resources/${digest}`,
              },
            ],
            structuredContent: {
              fileName: "file.txt",
              mimeType: "text/plain",
              byteLength: bytes.length,
              digest,
              digestAlgorithm: "sha-256",
            },
          };
        },
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "attachment-replay-test", version: "1" });
      await handle.server.connect(serverTransport);
      await client.connect(clientTransport);
      connections.push({ client, server: handle.server });
      return client;
    };
    const request = (
      client: Client,
      id = "13ca457c-72a2-470f-8be8-509a86a4b6a1",
      requestedPath = path,
    ) =>
      client.callTool({
        name: OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
        arguments: { path: requestedPath, omnicodexInvocationId: id },
      });
    try {
      await writeFile(path, "original bytes");
      const first = await connect(await MutationReplayStore.open({ snapshotPath }));
      const tool = (await first.listTools()).tools.find(
        (entry) => entry.name === OMNICODEX_ATTACH_LOCAL_FILE_TOOL,
      );
      expect(tool?.inputSchema.required).toContain("omnicodexInvocationId");
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      });
      const original = await request(first);
      expect(original.isError).not.toBe(true);
      await writeFile(path, "changed bytes after initial attachment");
      expect(await request(first)).toEqual(original);
      expect(reads).toBe(1);

      // A distinct durable path loads only disk state, without the process-wide store cache.
      await copyFile(snapshotPath, restartedPath);
      const restoredStore = await MutationReplayStore.open({ snapshotPath: restartedPath });
      const restarted = await connect(restoredStore);
      expect(await request(restarted)).toEqual(original);
      expect(reads).toBe(1);
      const fresh = await request(restarted, "45f6768d-6bf9-4164-8993-54be39f9024b");
      expect(fresh.isError).not.toBe(true);
      expect(fresh.structuredContent).not.toEqual(original.structuredContent);
      expect(reads).toBe(2);

      expect((await request(restarted, undefined, join(directory, "different.txt"))).isError).toBe(
        true,
      );
      expect((await request(await connect(restoredStore, "owner", "chat-b"))).isError).toBe(true);
      expect(reads).toBe(2);
      expect((await request(await connect(restoredStore, "other-owner"))).isError).not.toBe(true);
      expect(reads).toBe(3);
    } finally {
      await Promise.allSettled(connections.map(({ client }) => client.close()));
      await Promise.allSettled(connections.map(({ server }) => server.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
