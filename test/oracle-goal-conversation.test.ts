import { expect, it } from "vitest";
import {
  ORACLE_GOAL_CONVERSATION_SOURCE,
  parseOracleGoalConversation,
} from "../src/infrastructure/chatgpt/oracle-goal-conversation.js";

const project = new Function(`return (${ORACLE_GOAL_CONVERSATION_SOURCE})`)() as (
  id: string,
  conversation: unknown,
  connectorId: string,
) => unknown;
const preamble = {
  id: "preamble",
  author: { role: "assistant" },
  status: "finished_successfully",
  end_turn: true,
  channel: "commentary",
  metadata: {
    is_thinking_preamble_message: true,
    working_turn_id: "active-turn",
    turn_exchange_id: "active-turn",
  },
};
const final = {
  id: "rendered-final",
  author: { role: "assistant" },
  status: "finished_successfully",
  end_turn: true,
  channel: "final",
  metadata: { working_turn_id: "active-turn", turn_exchange_id: "active-turn" },
};

it("hydrates empty native Goal text by exact identity without replacing branch edges", () => {
  const goalId = "11111111-1111-4111-8111-111111111111";
  const message = {
    id: "goal-result",
    author: { role: "tool", name: "api_tool.call_tool" },
    status: "finished_successfully",
    metadata: {
      invoked_resource: { resource_uri: "/asdk_app_test/link_test/omnicodex__goal_get" },
    },
    content: { text: "" },
  };
  const hydrated = {
    ...message,
    parent_id: "wrong-parent",
    content: {
      text: JSON.stringify({
        id: goalId,
        state: "active",
        revision: 1,
        createdAtUnixMs: 1,
        steps: [],
      }),
    },
  };
  const read = (messages: unknown[], nativeText = "") =>
    parseOracleGoalConversation(
      project(
        "conversation",
        {
          current_node: final.id,
          messages,
          mapping: {
            [final.id]: { parent: message.id, message: final },
            [message.id]: { parent: null, message: { ...message, content: { text: nativeText } } },
          },
        },
        "asdk_app_test",
      ),
    );
  expect(read([hydrated]).goals[0]?.goalId).toBe(goalId);
  expect(read([hydrated]).current?.ancestorMessageIds).toEqual([message.id]);
  expect(read([{ ...hydrated, id: "sibling" }]).goals).toEqual([]);
  expect(
    read([
      {
        ...hydrated,
        metadata: { invoked_resource: { resource_uri: "/other/link_test/omnicodex__goal_get" } },
      },
    ]).goals,
  ).toEqual([]);
  expect(read([{ ...hydrated, author: { role: "assistant" } }]).goals).toEqual([]);
  expect(read([hydrated], "invalid-but-not-empty").goals).toEqual([]);
  expect(read([hydrated, { ...hydrated, content: { text: "{}" } }]).goals).toEqual([]);
});

it.each(["desktop", "web"] as const)("preserves a verified %s account source", (kind) => {
  const source = { kind, accountSourceId: "chatgpt:account-one:user-one" };
  const observation = {
    conversationUrl: "https://chatgpt.com/c/11111111-1111-4111-8111-111111111111",
    goals: [],
    source,
  };
  expect(parseOracleGoalConversation(observation).source).toEqual(source);
  expect(() =>
    parseOracleGoalConversation({ ...observation, source: { kind, accountSourceId: "unknown" } }),
  ).toThrow("ORACLE_GOAL_CONVERSATION_INVALID");
});

it("projects the latest user-selected Goal id from the current native branch", () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const goalResult = (id: string, messageId: string) => ({
    id: messageId,
    author: { role: "tool", name: "api_tool.call_tool" },
    status: "finished_successfully",
    metadata: {
      invoked_resource: { resource_uri: "/asdk_app_test/link_test/omnicodex__goal_create" },
    },
    content: {
      text: JSON.stringify({
        id,
        state: "active",
        revision: 1,
        createdAtUnixMs: id === firstId ? 1 : 2,
        steps: [],
      }),
    },
  });
  const result = parseOracleGoalConversation(
    project(
      "conversation",
      {
        current_node: final.id,
        messages: [
          goalResult(firstId, "first-result"),
          goalResult(secondId, "second-result"),
          {
            id: "selection",
            author: { role: "user" },
            content: { parts: [`Continue Goal ${secondId}.`] },
          },
          final,
        ],
      },
      "asdk_app_test",
    ),
  );
  expect(result.requestedGoalId).toBe(secondId);
  expect(() =>
    parseOracleGoalConversation({
      ...result,
      requestedGoalId: "33333333-3333-4333-8333-333333333333",
    }),
  ).toThrow("ORACLE_GOAL_CONVERSATION_INVALID");
});

it("projects only native parent edges and rejects cyclic ancestry instead of using array order", () => {
  const current = { ...final, parent_id: "middle" };
  const read = (messages: unknown[]) =>
    parseOracleGoalConversation(
      project(
        "conversation",
        {
          current_node: current.id,
          messages,
        },
        "asdk_app_test",
      ),
    );
  expect(
    read([current, { id: "older" }, { id: "middle", parent_id: "older" }]).current
      ?.ancestorMessageIds,
  ).toEqual(["middle", "older"]);
  expect(
    read([current, { id: "middle", parent_id: current.id }]).current?.ancestorMessageIds,
  ).toBeUndefined();
  expect(
    parseOracleGoalConversation(
      project(
        "conversation",
        {
          current_node: final.id,
          messages: [{ id: "older" }, final],
        },
        "asdk_app_test",
      ),
    ).current?.ancestorMessageIds,
  ).toBeUndefined();
});

it("uses the native current branch mapping and excludes sibling messages", () => {
  const result = parseOracleGoalConversation(
    project(
      "conversation",
      {
        current_node: final.id,
        mapping: {
          root: { parent: null, message: { id: "root" } },
          older: { parent: "root", message: { id: "older" } },
          [final.id]: { parent: "older", message: final },
          sibling: { parent: "root", message: { ...final, id: "sibling" } },
        },
      },
      "asdk_app_test",
    ),
  );
  expect(result.current?.id).toBe(final.id);
  expect(result.current?.ancestorMessageIds).toEqual(["older", "root"]);
});

it("preserves checkpoint ancestry across native mapping nodes with no message", () => {
  const result = parseOracleGoalConversation(
    project(
      "conversation",
      {
        current_node: final.id,
        mapping: {
          [final.id]: { parent: "empty-node", message: final },
          "empty-node": { parent: "checkpoint", message: null },
          checkpoint: { parent: "empty-root", message: { id: "checkpoint" } },
          "empty-root": { parent: null, message: null },
        },
      },
      "asdk_app_test",
    ),
  );
  expect(result.current?.ancestorMessageIds).toEqual(["empty-node", "checkpoint", "empty-root"]);
});

it("honors a native mapping root instead of following conflicting message metadata", () => {
  const result = parseOracleGoalConversation(
    project(
      "conversation",
      {
        current_node: final.id,
        mapping: {
          [final.id]: { parent: "root", message: final },
          root: {
            parent: null,
            message: { id: "root", metadata: { parent_id: "unrelated-checkpoint" } },
          },
        },
      },
      "asdk_app_test",
    ),
  );
  expect(result.current?.ancestorMessageIds).toEqual(["root"]);
});

it("rejects a cycle passing through an empty native mapping node", () => {
  const result = parseOracleGoalConversation(
    project(
      "conversation",
      {
        current_node: final.id,
        mapping: {
          [final.id]: { parent: "empty", message: final },
          empty: { parent: final.id, message: null },
        },
      },
      "asdk_app_test",
    ),
  );
  expect(result.current?.ancestorMessageIds).toBeUndefined();
});

it("rejects duplicate or self-referencing ancestry in an observation", () => {
  const valid = parseOracleGoalConversation(
    project(
      "conversation",
      {
        current_node: final.id,
        messages: [final],
      },
      "asdk_app_test",
    ),
  );
  for (const ancestorMessageIds of [[final.id], ["older", "older"], [23]])
    expect(() =>
      parseOracleGoalConversation({ ...valid, current: { ...valid.current, ancestorMessageIds } }),
    ).toThrow("ORACLE_GOAL_CONVERSATION_INVALID");
});

it("follows desktop PubSub metadata parent edges without using arrival order", () => {
  const result = parseOracleGoalConversation(
    project(
      "conversation",
      {
        current_node: final.id,
        messages: [
          { ...final, metadata: { parent_id: "tool-result" } },
          { id: "old-final", author: { role: "assistant" } },
          { id: "unrelated", metadata: { parent_id: "old-final" } },
          { id: "tool-result", metadata: { parent_id: "old-final" } },
        ],
      },
      "asdk_app_test",
    ),
  );
  expect(result.current?.ancestorMessageIds).toEqual(["tool-result", "old-final"]);
});

it.each(["blocked", "paused", "completed"])(
  "projects an authenticated %s Goal update without interpreting it as active",
  (state) => {
    const goalId = "11111111-1111-4111-8111-111111111111";
    const goal = { id: goalId, state, revision: 3, createdAtUnixMs: 1, steps: [] };
    const message = {
      id: "goal-update-result",
      author: { role: "tool", name: "api_tool.call_tool" },
      status: "finished_successfully",
      metadata: {
        invoked_resource: { resource_uri: "/asdk_app_test/link_test/omnicodex__goal_update" },
      },
      content: { text: JSON.stringify(goal) },
    };
    const result = parseOracleGoalConversation(
      project(
        "conversation",
        { messages: [message, final], current_node: final.id },
        "asdk_app_test",
      ),
    );
    expect(result.goals).toEqual([
      {
        messageId: message.id,
        toolName: "omnicodex__goal_update",
        goalId,
        state,
        revision: 3,
        createdAtUnixMs: 1,
      },
    ]);
  },
);

it("uses the same Pro turn's persisted final when current_node still points at its thinking preamble", () => {
  const result = parseOracleGoalConversation(
    project(
      "conversation",
      { current_node: "preamble", messages: [final, preamble] },
      "asdk_app_test",
    ),
  );
  expect(result.current).toEqual({
    id: "rendered-final",
    authorRole: "assistant",
    status: "finished_successfully",
    endTurn: true,
    channel: "final",
  });
});

it("does not borrow an older final, guess between final branches, or infer completion from a preamble", () => {
  for (const messages of [
    [preamble],
    [
      { ...final, metadata: { working_turn_id: "old-turn", turn_exchange_id: "old-turn" } },
      preamble,
    ],
    [final, { ...final, id: "alternative-final" }, preamble],
    [{ ...final, status: "interrupted" }, preamble],
  ]) {
    const result = parseOracleGoalConversation(
      project("conversation", { current_node: "preamble", messages }, "asdk_app_test"),
    );
    expect(result.current?.id).toBe("preamble");
    expect(result.current?.channel).toBe("commentary");
  }
  expect(
    parseOracleGoalConversation(
      project("conversation", { current_node: "missing", messages: [final] }, "asdk_app_test"),
    ),
  ).not.toHaveProperty("current");
});
