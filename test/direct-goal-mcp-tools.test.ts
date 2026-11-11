import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  beginDirectGoalExecution,
  callDirectGoalTool,
  type DirectGoalExecutionRecord,
  directGoalResourceDigest,
  directGoalTools,
  encodeDirectGoalContextToken,
  finalizeDirectGoalExecution,
  markDirectGoalExecutionDispatched,
  splitDirectGoalContext,
  withDirectGoalContext,
} from "../src/infrastructure/mcp/direct-goal-mcp-tools.js";
import { DirectGoalStore } from "../src/infrastructure/mcp/direct-goal-store.js";

const owner = "issuer\0owner\0client\0resource";
const claimant = "mcp-session-one";

describe("direct Goal MCP tools", () => {
  it("accepts reference steps without execution modes or tool allowlists", async () => {
    const stepsSchema = directGoalTools()[0]?.inputSchema.properties?.steps as {
      items: { properties: Record<string, unknown>; required: string[] };
    };
    expect(stepsSchema.items.required).toEqual(["id", "description"]);
    expect(Object.keys(stepsSchema.items.properties)).toEqual(["id", "description"]);
    const store = DirectGoalStore.inMemory();
    const created = await callDirectGoalTool(
      store,
      "omnicodex__goal_create",
      {
        objective: "Finish the requested work",
        steps: [{ id: "inspect", description: "Inspect the current result" }],
      },
      owner,
      claimant,
    );
    expect(created.structuredContent).toMatchObject({
      state: "active",
      steps: [{ id: "inspect", description: "Inspect the current result" }],
    });
    const id = (created.structuredContent as { id: string }).id;
    await expect(
      callDirectGoalTool(store, "omnicodex__goal_complete", { goalId: id }, owner, claimant),
    ).rejects.toThrow(
      "DIRECT_GOAL_HAS_UNFINISHED_STEPS: pending=1, claimed=0, awaiting_readback=0",
    );
  });

  it("treats an empty optional step list like an omitted step list", async () => {
    const store = DirectGoalStore.inMemory();
    const created = await callDirectGoalTool(
      store,
      "omnicodex__goal_create",
      {
        objective: "Continue without predefined steps",
        steps: [],
      },
      owner,
      claimant,
    );
    expect(created.structuredContent).toMatchObject({
      state: "active",
      steps: [],
      executionMode: "dynamic",
    });
  });

  it("starts from an objective alone and recovers the active Goal without caller bookkeeping", async () => {
    const store = DirectGoalStore.inMemory();
    expect(directGoalTools()[0]?.inputSchema.required).toEqual(["objective"]);
    const created = await callDirectGoalTool(
      store,
      "omnicodex__goal_create",
      { objective: "Deliver the requested file" },
      owner,
      claimant,
    );
    expect(created.structuredContent).toMatchObject({
      objective: "Deliver the requested file",
      executionMode: "dynamic",
      state: "active",
      steps: [],
    });
    expect(
      await callDirectGoalTool(
        store,
        "omnicodex__goal_create",
        { objective: "Deliver the requested file" },
        owner,
        "reconnected-session",
      ),
    ).toEqual(created);
    expect(await callDirectGoalTool(store, "omnicodex__goal_get", {}, owner, claimant)).toEqual(
      created,
    );
    await expect(
      callDirectGoalTool(
        store,
        "omnicodex__goal_create",
        { objective: "Replace unfinished work" },
        owner,
        claimant,
      ),
    ).rejects.toThrow("DIRECT_GOAL_ALREADY_ACTIVE");
  });

  it("lists and filters Goals across the account's authorized conversation bindings", async () => {
    const store = DirectGoalStore.inMemory();
    const otherOwner = "issuer\0owner\0client\0other-resource";
    const first = await store.create({ authorizationBinding: owner, objective: "Active Goal" });
    const second = await store.create({
      authorizationBinding: otherOwner,
      objective: "Paused Goal",
    });
    await store.updateStatus({
      authorizationBinding: otherOwner,
      goalId: second.id,
      status: "paused",
    });
    expect(
      (
        await callDirectGoalTool(store, "omnicodex__goal_list", {}, owner, claimant, [
          owner,
          otherOwner,
        ])
      ).structuredContent,
    ).toMatchObject({
      total: 2,
      counts: { active: 1, paused: 1, completed: 0, blocked: 0 },
      goals: expect.arrayContaining([
        expect.objectContaining({ id: first.id, state: "active" }),
        expect.objectContaining({ id: second.id, state: "paused" }),
      ]),
    });
    expect(
      (
        await callDirectGoalTool(
          store,
          "omnicodex__goal_list",
          { states: ["paused"] },
          owner,
          claimant,
          [owner, otherOwner],
        )
      ).structuredContent,
    ).toMatchObject({
      total: 1,
      counts: { active: 0, paused: 1, completed: 0, blocked: 0 },
      goals: [expect.objectContaining({ id: second.id, state: "paused" })],
    });
  });

  it("advertises native-action Goal controls without a model route", () => {
    const tools = directGoalTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "omnicodex__goal_create",
      "omnicodex__goal_get",
      "omnicodex__goal_list",
      "omnicodex__goal_claim_next_step",
      "omnicodex__goal_complete",
      "omnicodex__goal_update",
      "omnicodex__goal_delete",
    ]);
    expect(tools[0]?.description).toBe("Set the Goal for this Chat conversation");
    expect(tools[0]?.description).not.toContain("whenever");
    for (const tool of tools) {
      expect(tool._meta?.omnicodex).toMatchObject({
        route: "omnicodex_goal",
        modelEffect: "none",
        invokesModel: false,
      });
    }
    const create = tools[0]?.inputSchema as {
      properties?: {
        objective?: Record<string, unknown>;
        steps?: {
          description?: string;
          maxItems?: number;
          items?: { properties?: { description?: Record<string, unknown> } };
        };
      };
    };
    expect(create.properties?.objective).not.toHaveProperty("maxLength");
    expect(create.properties?.objective?.description).toBe("Goal objective.");
    expect(create.properties?.steps).not.toHaveProperty("maxItems");
    expect(create.properties?.steps?.description).toBe("Optional Goal steps.");
    expect(create.properties?.steps?.items?.properties?.description).not.toHaveProperty(
      "maxLength",
    );
    expect(tools.map((tool) => tool.description)).toEqual([
      "Set the Goal for this Chat conversation",
      "Get a Goal",
      "List manageable Goals across this account's Chat conversations",
      "Claim the next Goal step",
      "Complete a Goal",
      "Update a Goal",
      "Delete a Goal",
    ]);
    expect(
      tools.find((tool) => tool.name === "omnicodex__goal_update")?.inputSchema.properties,
    ).toHaveProperty("status.enum", ["active", "complete", "paused", "blocked"]);
  });

  it("deletes a Goal, hides it from reads, and permits a new Goal in the conversation", async () => {
    const store = DirectGoalStore.inMemory();
    const created = await callDirectGoalTool(
      store,
      "omnicodex__goal_create",
      { idempotencyKey: "delete-goal-test-0001", objective: "Temporary Goal" },
      owner,
      claimant,
    );
    const goalId = (created.structuredContent as { id: string }).id;

    const deleted = await callDirectGoalTool(
      store,
      "omnicodex__goal_delete",
      { goalId },
      owner,
      claimant,
    );
    expect(deleted.structuredContent).toMatchObject({ goalId, deleted: true });
    expect(
      await callDirectGoalTool(store, "omnicodex__goal_delete", { goalId }, owner, claimant),
    ).toEqual(deleted);
    expect(
      await callDirectGoalTool(store, "omnicodex__goal_get", { goalId }, owner, claimant),
    ).toMatchObject({ isError: true });
    expect(
      await callDirectGoalTool(store, "omnicodex__goal_get", {}, owner, claimant),
    ).toMatchObject({ isError: true });

    const next = await callDirectGoalTool(
      store,
      "omnicodex__goal_create",
      { idempotencyKey: "delete-goal-test-0001", objective: "Replacement Goal" },
      owner,
      claimant,
    );
    expect(next.structuredContent).toMatchObject({
      objective: "Replacement Goal",
      state: "active",
    });
    expect((next.structuredContent as { id: string }).id).not.toBe(goalId);
  });

  it("pauses, resumes, completes, and reopens the same Goal while retaining reference steps", async () => {
    const store = DirectGoalStore.inMemory();
    const goal = await store.create({
      authorizationBinding: owner,
      idempotencyKey: "mcp-goal-update-0001",
      objective: "Complete the exact work",
      steps: [{ id: "read", description: "Read source", mode: "successful_call" }],
    });
    const blocked = await callDirectGoalTool(
      store,
      "omnicodex__goal_update",
      {
        goalId: goal.id,
        status: "blocked",
        reason: "Verified external impasse after continued attempts",
      },
      owner,
      claimant,
    );
    expect(blocked.structuredContent).toMatchObject({ id: goal.id, state: "blocked" });
    const resumed = await callDirectGoalTool(
      store,
      "omnicodex__goal_update",
      { goalId: goal.id, status: "active" },
      owner,
      claimant,
    );
    expect(resumed.structuredContent).toMatchObject({ id: goal.id, state: "active" });
    const paused = await callDirectGoalTool(
      store,
      "omnicodex__goal_update",
      { goalId: goal.id, status: "paused" },
      owner,
      claimant,
    );
    expect(paused.structuredContent).toMatchObject({ id: goal.id, state: "paused" });
    const continued = await callDirectGoalTool(
      store,
      "omnicodex__goal_update",
      { goalId: goal.id, status: "active" },
      owner,
      claimant,
    );
    expect(continued.structuredContent).toMatchObject({ id: goal.id, state: "active" });
    await expect(
      callDirectGoalTool(
        store,
        "omnicodex__goal_update",
        { goalId: goal.id, status: "complete" },
        owner,
        claimant,
      ),
    ).rejects.toThrow(
      "DIRECT_GOAL_HAS_UNFINISHED_STEPS: pending=1, claimed=0, awaiting_readback=0",
    );
    const claim = await store.claimNext({
      authorizationBinding: owner,
      claimantBinding: claimant,
      goalId: goal.id,
    });
    if (claim === undefined) throw new Error("Missing Goal claim");
    const execution: DirectGoalExecutionRecord = {
      authorizationBinding: owner,
      claimantBinding: claimant,
      context: {
        goalId: goal.id,
        stepId: "read",
        claimToken: claim.claimToken,
        role: "work",
      },
      operationId: "goal-lifecycle-read",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      stateEffect: "read",
      modelEffect: "none",
      outcome: "succeeded",
      arguments: { path: "C:\\work\\source.txt" },
      result: { content: [{ type: "text", text: "contents" }] },
    };
    await beginDirectGoalExecution(store, execution);
    await markDirectGoalExecutionDispatched(store, execution);
    await finalizeDirectGoalExecution(store, execution);
    const completed = await callDirectGoalTool(
      store,
      "omnicodex__goal_update",
      { goalId: goal.id, status: "complete" },
      owner,
      claimant,
    );
    expect(completed.structuredContent).toMatchObject({
      id: goal.id,
      state: "completed",
      steps: [{ id: "read", state: "completed", receipts: [expect.any(Object)] }],
    });
    const reopened = await callDirectGoalTool(
      store,
      "omnicodex__goal_update",
      { goalId: goal.id, status: "active" },
      owner,
      claimant,
    );
    expect(reopened.structuredContent).toMatchObject({
      id: goal.id,
      state: "active",
      steps: [{ id: "read", state: "completed", receipts: [expect.any(Object)] }],
    });
    await expect(
      callDirectGoalTool(
        store,
        "omnicodex__goal_update",
        { goalId: goal.id, status: "unknown" },
        owner,
        claimant,
      ),
    ).rejects.toThrow("DIRECT_GOAL_STATUS_INVALID");
  });

  it("revises the objective on the same Goal without replacing its durable state", async () => {
    const store = DirectGoalStore.inMemory();
    const goal = await store.create({
      authorizationBinding: owner,
      objective: "Initial objective",
    });
    const tools = directGoalTools();
    const update = tools.find((tool) => tool.name === "omnicodex__goal_update");
    expect(update?.inputSchema.required).toEqual(["goalId"]);
    expect(update?.inputSchema.properties).toHaveProperty("objective");

    const revised = await callDirectGoalTool(
      store,
      "omnicodex__goal_update",
      { goalId: goal.id, objective: "Revised objective with every existing capability" },
      owner,
      claimant,
    );
    expect(revised.structuredContent).toMatchObject({
      id: goal.id,
      objective: "Revised objective with every existing capability",
      state: "active",
      revision: goal.revision + 1,
    });
    await expect(
      callDirectGoalTool(store, "omnicodex__goal_update", { goalId: goal.id }, owner, claimant),
    ).rejects.toThrow("DIRECT_GOAL_UPDATE_EMPTY");
  });

  it("keeps native schemas exact while accepting a legacy Goal token during rolling upgrades", () => {
    const nativeTool: Tool = {
      name: "codex__app_server__fs_readFile",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    };
    const tool = withDirectGoalContext(nativeTool);
    expect(tool).toBe(nativeTool);
    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    });
    expect(tool.inputSchema.properties).not.toHaveProperty("omnicodexGoalContext");

    const token = encodeDirectGoalContextToken({
      goalId: "goal-1",
      stepId: "read",
      claimToken: "a".repeat(43),
      role: "work",
    });

    const split = splitDirectGoalContext({
      path: "C:\\work\\target.txt",
      omnicodexGoalContext: token,
    });
    expect(split.arguments).toEqual({ path: "C:\\work\\target.txt" });
    expect(split.goal).toMatchObject({ goalId: "goal-1", stepId: "read", role: "work" });
    expect(() => splitDirectGoalContext({ omnicodexGoalContext: { goalId: "goal-1" } })).toThrow(
      "valid Goal action token",
    );
  });

  it("refuses completion while an operation is running and completes after its result", async () => {
    const store = DirectGoalStore.inMemory();
    const created = await callDirectGoalTool(
      store,
      "omnicodex__goal_create",
      {
        idempotencyKey: "goal-create-mcp-000000000001",
        objective: "Read one exact file directly.",
        steps: [
          {
            id: "read",
            description: "Read the file.",
            mode: "successful_call",
            allowedToolNames: ["codex__app_server__fs_readFile"],
          },
        ],
      },
      owner,
      claimant,
    );
    const goal = JSON.parse(
      created.content[0]?.type === "text" ? created.content[0].text : "{}",
    ) as {
      id: string;
    };
    const claimResult = await callDirectGoalTool(
      store,
      "omnicodex__goal_claim_next_step",
      { goalId: goal.id },
      owner,
      claimant,
    );
    const claim = JSON.parse(
      claimResult.content[0]?.type === "text" ? claimResult.content[0].text : "{}",
    ) as { claimToken: string; omnicodexGoalContext: string };
    expect(
      splitDirectGoalContext({ omnicodexGoalContext: claim.omnicodexGoalContext }).goal,
    ).toEqual({
      goalId: goal.id,
      stepId: "read",
      claimToken: claim.claimToken,
      role: "work",
    });

    const execution: DirectGoalExecutionRecord = {
      authorizationBinding: owner,
      claimantBinding: claimant,
      context: {
        goalId: goal.id,
        stepId: "read",
        claimToken: claim.claimToken,
        role: "work",
      },
      operationId: "native-read-operation-0001",
      toolName: "codex__app_server__fs_readFile",
      targetIdentity: "app_server\0fs/readFile",
      stateEffect: "read",
      modelEffect: "none",
      outcome: "succeeded",
      arguments: { path: "C:\\work\\target.txt" },
      result: { content: [{ type: "text", text: "contents" }] },
    };
    await beginDirectGoalExecution(store, execution);
    await markDirectGoalExecutionDispatched(store, execution);
    await expect(
      callDirectGoalTool(store, "omnicodex__goal_complete", { goalId: goal.id }, owner, claimant),
    ).rejects.toThrow(
      "DIRECT_GOAL_HAS_UNFINISHED_STEPS: pending=0, claimed=1, awaiting_readback=0",
    );
    await finalizeDirectGoalExecution(store, execution);
    const completed = await callDirectGoalTool(
      store,
      "omnicodex__goal_complete",
      { goalId: goal.id },
      owner,
      claimant,
    );
    expect(completed.isError).not.toBe(true);
    expect(await store.get(owner, goal.id)).toMatchObject({
      state: "completed",
      steps: [
        {
          id: "read",
          state: "completed",
          receipts: [
            {
              operationId: execution.operationId,
              toolName: execution.toolName,
              resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          ],
        },
      ],
    });
  });

  it("passes caller-sized goal text and leases through the MCP adapter without narrowing", async () => {
    const store = DirectGoalStore.inMemory({ nowUnixMs: () => 100 });
    const objective = `objective:${"o".repeat(33_000)}`;
    const description = `description:${"d".repeat(8_300)}`;
    const created = await callDirectGoalTool(
      store,
      "omnicodex__goal_create",
      {
        idempotencyKey: "goal-create-mcp-unbounded-0001",
        objective,
        steps: [{ id: "read", description, mode: "successful_call" }],
      },
      owner,
      claimant,
    );
    const goal = JSON.parse(
      created.content[0]?.type === "text" ? created.content[0].text : "{}",
    ) as { id: string; objective: string; steps: Array<{ description: string }> };
    expect(goal.objective).toBe(objective);
    expect(goal.steps[0]?.description).toBe(description);

    const claimed = await callDirectGoalTool(
      store,
      "omnicodex__goal_claim_next_step",
      { goalId: goal.id, leaseMs: 1_800_001 },
      owner,
      claimant,
    );
    const claim = JSON.parse(
      claimed.content[0]?.type === "text" ? claimed.content[0].text : "{}",
    ) as { claimExpiresAtUnixMs: number };
    expect(claim.claimExpiresAtUnixMs).toBe(1_800_101);
  });

  it("normalizes resource identities so write and read calls on one file match", () => {
    expect(
      directGoalResourceDigest({ filePaths: ["C:\\work\\b.txt\\", "C:/work/a.txt"] }, "write"),
    ).toBe(directGoalResourceDigest({ filePaths: ["c:\\WORK\\A.TXT", "c:/WORK/b.txt"] }, "read"));
    expect(directGoalResourceDigest({}, "write")).not.toBe(directGoalResourceDigest({}, "read"));
  });

  it("lets a readback narrow a workspace-scoped command to a descendant file", () => {
    const workspaceOnly = directGoalResourceDigest(
      { workspacePaths: ["C:\\work"] },
      "app_server\0command/exec",
    );
    expect(
      directGoalResourceDigest(
        {
          workspacePaths: ["c:/WORK/"],
          filePaths: ["C:\\work\\evidence\\readback.json"],
        },
        "app_server\0fs/readFile",
        "readback",
      ),
    ).toBe(workspaceOnly);
    expect(
      directGoalResourceDigest(
        {
          workspacePaths: ["C:\\work"],
          filePaths: ["C:\\outside\\readback.json"],
        },
        "app_server\0fs/readFile",
        "readback",
      ),
    ).not.toBe(workspaceOnly);
  });
});
