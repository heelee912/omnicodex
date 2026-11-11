import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";
import { DurableWorkSessionStore } from "../src/infrastructure/mcp/durable-work-session-store.js";
import { MutationReplayStore } from "../src/infrastructure/mcp/mutation-replay-store.js";
import { createOmniCodexMcpServer } from "../src/infrastructure/mcp/omnicodex-mcp-server.js";

it("manages an explicit Goal across authorized conversations without changing the current Goal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-goal-target-"));
  const workSessions = await DurableWorkSessionStore.open({ dataDirectory: directory });
  const goals = DirectGoalStore.inMemory();
  const connections: Array<{ client: Client; close: () => Promise<void> }> = [];
  const connect = async (principal: string, conversation: string) => {
    const authorizationBinding = `issuer\0${principal}\0client\0resource`;
    const binding = await workSessions.bind({
      authorizationBinding,
      transportSessionId: `transport-${connections.length}`,
      requestMeta: { "openai/session": conversation },
    });
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>() => ({ data: [], nextCursor: null }) as T },
      directGoalStore: goals,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding,
      resolveDurableWorkSessionBinding: () => binding,
      listAuthorizedGoalWorkSessionBindings: () =>
        workSessions.listOwnedWorkSessionBindings(authorizationBinding),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "goal-management", version: "1" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, close: () => handle.server.close() });
    return client;
  };
  const call = async (client: Client, action: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name: `omnicodex__goal_${action}`, arguments: args });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent as Record<string, unknown>;
  };
  try {
    const first = await connect("signed-in-owner", "web-account-one-conversation");
    const second = await connect("signed-in-owner", "web-account-two-conversation");
    const stranger = await connect("different-owner", "web-account-one-conversation");
    const firstGoal = await call(first, "create", { objective: "First conversation objective" });
    const secondGoal = await call(second, "create", { objective: "Second conversation objective" });
    expect(await call(second, "list")).toMatchObject({
      total: 2,
      counts: { active: 2, paused: 0, completed: 0, blocked: 0 },
      goals: expect.arrayContaining([
        expect.objectContaining({ id: firstGoal.id }),
        expect.objectContaining({ id: secondGoal.id }),
      ]),
    });
    expect(await call(stranger, "list")).toMatchObject({ total: 0, goals: [] });
    const goalId = firstGoal.id as string;
    const conversationUrl = "https://chatgpt.com/c/managed-conversation";
    await goals.observeConversation({
      conversationUrl,
      source: { kind: "web", accountSourceId: "chatgpt:web:account-one" },
      goals: [
        {
          messageId: "goal-created-result",
          toolName: "omnicodex__goal_create",
          goalId,
          state: "active",
          revision: firstGoal.revision as number,
          createdAtUnixMs: firstGoal.createdAtUnixMs as number,
        },
      ],
    });
    expect(await call(second, "get", { goalId })).toMatchObject({
      id: goalId,
      objective: firstGoal.objective,
      state: "active",
    });
    expect(await call(second, "get", { conversationUrl })).toMatchObject({ id: goalId });
    expect(await call(second, "get")).toEqual(secondGoal);
    for (const args of [{ goalId }, { conversationUrl }]) {
      const denied = await stranger.callTool({ name: "omnicodex__goal_get", arguments: args });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("DIRECT_GOAL_NOT_FOUND");
      expect(JSON.stringify(denied)).not.toContain(firstGoal.objective);
    }
    expect(await call(second, "update", { goalId, status: "paused" })).toMatchObject({
      state: "paused",
    });
    expect(await call(second, "list", { states: ["paused"] })).toMatchObject({
      total: 1,
      goals: [expect.objectContaining({ id: goalId, state: "paused" })],
    });
    expect(await call(first, "get")).toMatchObject({ id: goalId, state: "paused" });
    const reconnected = await connect("signed-in-owner", "web-account-two-conversation");
    expect(
      await call(reconnected, "update", {
        goalId,
        objective: "Updated first objective",
        status: "active",
      }),
    ).toMatchObject({ id: goalId, objective: "Updated first objective", state: "active" });
    expect(await call(reconnected, "complete", { goalId })).toMatchObject({ state: "completed" });
    const deleted = await call(reconnected, "delete", { goalId });
    expect(deleted).toMatchObject({ goalId, deleted: true });
    expect(await call(reconnected, "delete", { goalId })).toEqual(deleted);
    expect((await first.callTool({ name: "omnicodex__goal_get", arguments: {} })).isError).toBe(
      true,
    );
    expect(await call(second, "get")).toEqual(secondGoal);
    const reconnectGoal = await call(first, "create", {
      objective: "Continue this account's Goal after a Web conversation reconnect",
      steps: [{ id: "resume", description: "Resume the existing work", mode: "successful_call" }],
    });
    expect(
      await call(second, "claim_next_step", { goalId: reconnectGoal.id as string }),
    ).toMatchObject({
      goal: { id: reconnectGoal.id },
      step: { id: "resume", state: "claimed" },
    });
  } finally {
    for (const connection of connections) {
      await connection.client.close();
      await connection.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

it("isolates Goal controls and creation retries by durable conversation across MCP reconnects", async () => {
  const store = DirectGoalStore.inMemory();
  const connections: Array<{ client: Client; close: () => Promise<void> }> = [];
  const connect = async (session?: string, failResolution = false) => {
    const handle = createOmniCodexMcpServer({
      appServer: { request: async <T>() => ({ data: [], nextCursor: null }) as T },
      directGoalStore: store,
      mutationReplayStore: MutationReplayStore.inMemory(),
      authorizationBinding: "issuer\0same-owner\0client\0resource",
      correlationId: `transport-${connections.length}`,
      ...(session === undefined
        ? {}
        : {
            resolveDurableWorkSessionBinding: () => {
              if (failResolution) throw new Error("CONVERSATION_RESOLUTION_FAILED");
              return {
                workSessionBinding: session,
                directGoalClaimantBinding: session,
                directJobOwnerBinding: session,
                continuationToken: `continuation-${session}`,
                journalCursor: "cursor",
              };
            },
          }),
      surface: "full",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "goal-isolation", version: "1.0.0" });
    await handle.server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, close: () => handle.server.close() });
    return client;
  };
  try {
    const first = await connect("conversation-a");
    const second = await connect("conversation-b");
    const definition = {
      idempotencyKey: "same-create-retry-identity",
      objective: "Inspect the requested local project",
      steps: [{ id: "inspect", description: "Read the project", mode: "successful_call" }],
    };
    const created = await first.callTool({ name: "omnicodex__goal_create", arguments: definition });
    expect(created.isError, JSON.stringify(created)).not.toBe(true);
    const goalId = (created.structuredContent as { id: string }).id;
    for (const name of [
      "omnicodex__goal_get",
      "omnicodex__goal_claim_next_step",
      "omnicodex__goal_complete",
    ]) {
      const denied = await second.callTool({ name, arguments: { goalId } });
      expect(denied.isError, name).toBe(true);
      expect(JSON.stringify(denied)).toContain("DIRECT_GOAL_NOT_FOUND");
      expect(JSON.stringify(denied)).not.toContain(definition.objective);
    }
    const independent = await second.callTool({
      name: "omnicodex__goal_create",
      arguments: definition,
    });
    expect(independent.isError).not.toBe(true);
    expect((independent.structuredContent as { id: string }).id).not.toBe(goalId);
    expect(
      (await second.callTool({ name: "omnicodex__goal_get", arguments: {} })).structuredContent,
    ).toEqual(independent.structuredContent);
    const replacement = await first.callTool({
      name: "omnicodex__goal_create",
      arguments: { ...definition, idempotencyKey: "different-create-identity" },
    });
    expect(replacement.isError).toBe(true);
    expect(JSON.stringify(replacement)).toContain("DIRECT_GOAL_ALREADY_ACTIVE");
    const reconnected = await connect("conversation-a");
    expect(
      (await reconnected.callTool({ name: "omnicodex__goal_get", arguments: { goalId } }))
        .structuredContent,
    ).toEqual(created.structuredContent);
    expect(
      (await reconnected.callTool({ name: "omnicodex__goal_get", arguments: {} }))
        .structuredContent,
    ).toEqual(created.structuredContent);
    expect(
      (await reconnected.callTool({ name: "omnicodex__goal_create", arguments: definition }))
        .structuredContent,
    ).toEqual(created.structuredContent);
    for (const connection of [await connect(), await connect("conversation-a", true)]) {
      const unavailable = await connection.callTool({
        name: "omnicodex__goal_create",
        arguments: definition,
      });
      expect(unavailable.isError).toBe(true);
      expect(JSON.stringify(unavailable)).toMatch(
        /DURABLE_WORK_SESSION_UNAVAILABLE|CONVERSATION_RESOLUTION_FAILED/u,
      );
    }
  } finally {
    for (const connection of connections) {
      await connection.client.close();
      await connection.close();
    }
  }
});
