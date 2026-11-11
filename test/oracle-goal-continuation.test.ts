import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  type ChromeGoalContinuationTarget,
  goalContinuationPrompt,
} from "../src/application/chrome-goal-continuation.js";
import { ChatGptLoopbackCdpTransport } from "../src/infrastructure/chatgpt/chatgpt-cdp-transport.js";
import { ORACLE_GOAL_BODY_HYDRATION_SOURCE } from "../src/infrastructure/chatgpt/oracle-goal-body-hydration.js";
import {
  isOracleGoalContinuationExpression,
  oracleGoalContinuationExpression,
} from "../src/infrastructure/chatgpt/oracle-goal-continuation.js";

const connector = "asdk_app_test";
const id = "11111111-1111-4111-8111-111111111111";
const goalId = "22222222-2222-4222-8222-222222222222";
const target: ChromeGoalContinuationTarget = {
  goalId,
  conversationUrl: `https://chatgpt.com/c/${id}`,
  operation: "send",
  draft: {
    token: "33333333-3333-4333-8333-333333333333",
    afterMessageId: "final",
    state: "dispatching",
  },
};

interface Message {
  id: string;
  author: { role: string; name?: string };
  metadata?: {
    selected_sources?: string[];
    disable_tool_ids?: string[];
    invoked_resource?: { resource_uri: string };
    [key: string]: unknown;
  };
  content?: { text?: string; parts?: string[]; content_type?: string };
  [key: string]: unknown;
}
interface RequestOptions {
  requestBody: { messages: Message[]; [key: string]: unknown };
  [key: string]: unknown;
}

function fixture() {
  const conversation = {
    conversation_id: id,
    current_node: "final",
    default_model_slug: "native-pro-model",
    disabled_tool_ids: ["unselected-tool"],
    messages: [
      { id: "user", author: { role: "user" }, metadata: { selected_sources: ["selected-source"] } },
      {
        id: "goal-result",
        author: { role: "tool", name: "api_tool.call_tool" },
        status: "finished_successfully",
        metadata: {
          invoked_resource: { resource_uri: `/${connector}/link_test/omnicodex__goal_get` },
        },
        content: {
          text: JSON.stringify({
            id: goalId,
            state: "active",
            revision: 2,
            createdAtUnixMs: 1,
            steps: [],
          }),
        },
      },
      {
        id: "final",
        author: { role: "assistant" },
        status: "finished_successfully",
        end_turn: true,
        channel: "final",
        metadata: {
          thinking_effort: "native-effort",
          working_turn_id: "turn",
          turn_exchange_id: "exchange",
        },
      },
    ] as Message[],
  };
  const storage = new Map<string, string>();
  const safeGet = vi.fn(
    async (_path?: string): Promise<Record<string, unknown>> => structuredClone(conversation),
  );
  const safePost = vi.fn(async (_path: string, _options: Record<string, unknown>) => ({
    conduit_token: "native-conduit-token",
  }));
  const request = vi.fn(async (_method: string, _path: string, options: RequestOptions) => {
    const message = options.requestBody.messages.at(-1);
    if (!message) throw new Error("Missing user message");
    conversation.messages.push(message);
    conversation.current_node = message.id;
    return { status: 200 };
  });
  const prepare = vi.fn(async () => ({}));
  const runtime = {
    requestClient: { safeGet, safePost, request },
    module: {
      Eo: prepare,
      Fo: vi.fn(),
      Ao: vi.fn(() => ({})),
      Uo: { getEnforcementToken: vi.fn() },
      zo: { getEnforcementToken: vi.fn() },
    },
    backoffUntil: 0,
  };
  const context = {
    URL,
    crypto: { randomUUID },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    [`__omnicodexOracleServerApprovalV2:${connector}`]: runtime,
  };
  return {
    conversation,
    context,
    runtime,
    safeGet,
    safePost,
    request,
    prepare,
    storage,
    run: (input = target) =>
      runInNewContext(oracleGoalContinuationExpression(connector, input), context),
  };
}

describe("native Web Goal continuation", () => {
  it.each(["id", "uri", "status"])(
    "does not reuse a recovered body with changed %s",
    async (field) => {
      const f = fixture();
      const original = structuredClone(f.conversation.messages[1]);
      if (!original) throw new Error("Missing fixture Goal");
      const recovered = structuredClone(original);
      if (field === "id") recovered.id = "different-result";
      if (field === "uri")
        recovered.metadata = {
          invoked_resource: { resource_uri: `/${connector}/link_other/omnicodex__goal_get` },
        };
      if (field === "status") recovered.status = "in_progress";
      original.content = { text: "" };
      const safeGet = vi.fn(async () => {
        throw new Error("fresh body requested");
      });
      const hydrate = runInNewContext(`(${ORACLE_GOAL_BODY_HYDRATION_SOURCE})`);
      await expect(
        hydrate(
          connector,
          () => {},
          id,
          {
            current_node: original.id,
            mapping: { [original.id]: { message: original, parent: null } },
          },
          { safeGet },
          "read",
          [recovered],
        ),
      ).rejects.toThrow("fresh body requested");
      expect(safeGet).toHaveBeenCalledOnce();
    },
  );

  it("reads only one current turn for every continuation check", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ outcome: "sent" });
    expect(f.request).toHaveBeenCalledOnce();
    for (const call of f.safeGet.mock.calls)
      expect(call).toEqual([
        `/conversations/${id}`,
        {
          parameters: { query: { include_has_versions: true, num_turns: 1 } },
          disableAutomaticRetry: true,
        },
      ]);
  });

  function accountContext(f: ReturnType<typeof fixture>, accountId = "A") {
    const document = { body: { innerText: "" } };
    const setAccount = (account: string) => {
      document.body.innerText = JSON.stringify({
        accessToken: `test.${Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: account, user_id: "U" },
          }),
        ).toString("base64url")}.test`,
      });
    };
    setAccount(accountId);
    Object.assign(f.context, {
      atob,
      document,
      location: { origin: "https://chatgpt.com", pathname: "/api/auth/session" },
    });
    return setAccount;
  }

  it("checks the target account inside the renderer before every conversation operation", async () => {
    const f = fixture();
    accountContext(f);
    expect(await f.run({ ...target, accountSourceId: "chatgpt:B:U" })).toEqual({
      outcome: "account_source_mismatch",
    });
    expect(f.safeGet).not.toHaveBeenCalled();
    expect(f.safePost).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(await f.run({ ...target, accountSourceId: "chatgpt:A:U" })).toEqual({ outcome: "sent" });
  });

  it("does not return another account's inspect result after login changes during read", async () => {
    const f = fixture();
    const setAccount = accountContext(f);
    f.safeGet.mockImplementationOnce(async () => {
      setAccount("B");
      return structuredClone(f.conversation);
    });
    expect(
      await f.run({ ...target, operation: "inspect", accountSourceId: "chatgpt:A:U" }),
    ).toEqual({ outcome: "account_source_mismatch" });
    expect(f.safePost).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not prepare or send after the account changes during prerequisite work", async () => {
    const f = fixture();
    const setAccount = accountContext(f);
    f.prepare.mockImplementationOnce(async () => {
      setAccount("B");
      return {};
    });
    expect(await f.run({ ...target, accountSourceId: "chatgpt:A:U" })).toEqual({
      outcome: "account_source_mismatch",
    });
    expect(f.safeGet).toHaveBeenCalledTimes(1);
    expect(f.safePost).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not create a dispatch journal or send when login changes during prepare", async () => {
    const f = fixture();
    const setAccount = accountContext(f);
    f.safePost.mockImplementationOnce(async () => {
      setAccount("B");
      return { conduit_token: "test" };
    });
    expect(await f.run({ ...target, accountSourceId: "chatgpt:A:U" })).toEqual({
      outcome: "account_source_mismatch",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.storage.get(`__omnicodexGoalDispatches:${connector}`)).toBeUndefined();
  });

  it("preserves an accepted send as unconfirmed if the account changes before readback", async () => {
    const f = fixture();
    const setAccount = accountContext(f);
    f.request.mockImplementationOnce(async () => {
      setAccount("B");
      return { status: 200 };
    });
    expect(await f.run({ ...target, accountSourceId: "chatgpt:A:U" })).toEqual({
      outcome: "send_unconfirmed",
    });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.storage.get(`__omnicodexGoalDispatches:${connector}`)).toContain(target.draft.token);
  });

  it("sends with no conversation tab and preserves model, effort, sources and disabled tools", async () => {
    const f = fixture();
    expect(await f.run()).toEqual({ outcome: "sent" });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.safePost).toHaveBeenCalledOnce();
    expect(f.safePost).toHaveBeenCalledWith(
      "/f/conversation/prepare",
      expect.objectContaining({
        authOption: 1,
        disableAutomaticRetry: true,
        requestBody: expect.objectContaining({
          conversation_id: id,
          parent_message_id: "final",
          model: "native-pro-model",
          client_prepare_state: "none",
          thinking_effort: "native-effort",
        }),
      }),
    );
    const call = f.request.mock.calls[0];
    if (!call) throw new Error("Missing native request");
    const [method, path, options] = call;
    expect([method, path]).toEqual(["post", "/f/conversation"]);
    expect(options).toMatchObject({
      authOption: 1,
      disableAutomaticRetry: true,
      additionalHeaders: { "x-conduit-token": "native-conduit-token" },
      requestBody: {
        conversation_id: id,
        parent_message_id: "final",
        model: "native-pro-model",
        client_prepare_state: "success",
        thinking_effort: "native-effort",
      },
    });
    expect(options.requestBody.messages[0]?.metadata?.disable_tool_ids).toEqual([
      "unselected-tool",
    ]);
    expect(options.requestBody.messages[1]).toMatchObject({
      id: target.draft.token,
      content: { parts: [goalContinuationPrompt(goalId)] },
      metadata: { selected_sources: ["selected-source"] },
    });
    expect(await f.run()).toEqual({ outcome: "sent" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("accepts a successful assistant end-turn when the native response omits channel", async () => {
    const f = fixture();
    const final = f.conversation.messages.at(-1);
    if (!final) throw new Error("Missing final fixture message");
    delete final.channel;

    expect(await f.run()).toEqual({ outcome: "sent" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("resumes a selected Goal request that persisted as an idle user-only head", async () => {
    const f = fixture();
    const recoveryUser = {
      id: "resume-user-message",
      author: { role: "user" },
      status: "finished_successfully",
      metadata: { selected_sources: ["selected-source"] },
    };
    f.conversation.messages = [...(f.conversation.messages.slice(0, 2) as Message[]), recoveryUser];
    f.conversation.current_node = recoveryUser.id;
    const recoveryTarget: ChromeGoalContinuationTarget = {
      ...target,
      draft: {
        ...target.draft,
        afterMessageId: recoveryUser.id,
        resumeIdleUserTurn: true,
      },
    };

    expect(
      await f.run({
        ...recoveryTarget,
        operation: "inspect",
        draft: { ...recoveryTarget.draft, state: "ready" },
      }),
    ).toEqual({ outcome: "ready" });
    expect(await f.run(recoveryTarget)).toEqual({ outcome: "sent" });
    expect(f.request.mock.calls[0]?.[2].requestBody.parent_message_id).toBe(recoveryUser.id);

    const withoutIdleProof = fixture();
    withoutIdleProof.conversation.messages = [
      ...(withoutIdleProof.conversation.messages.slice(0, 2) as Message[]),
      recoveryUser,
    ];
    withoutIdleProof.conversation.current_node = recoveryUser.id;
    expect(
      await withoutIdleProof.run({
        ...target,
        operation: "inspect",
        draft: { ...target.draft, afterMessageId: recoveryUser.id, state: "ready" },
      }),
    ).toEqual({ outcome: "generating" });
  });

  it("resumes an idle assistant tool head that stopped before a final response", async () => {
    const f = fixture();
    const incompleteAssistant = {
      id: "assistant-tool-head",
      author: { role: "assistant" },
      status: "finished_successfully",
      end_turn: false,
      metadata: { selected_sources: ["selected-source"] },
    };
    f.conversation.messages = [
      ...(f.conversation.messages.slice(0, 2) as Message[]),
      incompleteAssistant,
    ];
    f.conversation.current_node = incompleteAssistant.id;
    const recoveryTarget: ChromeGoalContinuationTarget = {
      ...target,
      draft: {
        ...target.draft,
        afterMessageId: incompleteAssistant.id,
        resumeIdleIncompleteTurn: true,
      },
    };

    expect(
      await f.run({
        ...recoveryTarget,
        operation: "inspect",
        draft: { ...recoveryTarget.draft, state: "ready" },
      }),
    ).toEqual({ outcome: "ready" });
    expect(await f.run(recoveryTarget)).toEqual({ outcome: "sent" });
    expect(f.request.mock.calls[0]?.[2].requestBody.parent_message_id).toBe(incompleteAssistant.id);
  });

  it.each(["reversed", "sibling"])(
    "preserves the current branch tool selection with %s message order",
    async (order) => {
      const f = fixture();
      const [user, goal, final] = f.conversation.messages;
      if (!user || !goal || !final) throw new Error("Missing fixture branch");
      goal.parent_id = user.id;
      final.parent_id = goal.id;
      if (order === "reversed") f.conversation.messages.reverse();
      else
        f.conversation.messages.splice(2, 0, {
          id: "sibling-user",
          author: { role: "user" },
          parent_id: "other-branch",
          metadata: { selected_sources: ["unrelated-selection"] },
        });
      expect(await f.run()).toEqual({ outcome: "sent" });
      expect(
        f.request.mock.calls[0]?.[2].requestBody.messages.at(-1)?.metadata?.selected_sources,
      ).toEqual(["selected-source"]);
    },
  );

  it.each(["missing", "empty", "replacement"])(
    "preserves the latest explicit branch selection when the latest message selection is %s",
    async (selection) => {
      const f = fixture();
      const [user, goal, final] = f.conversation.messages;
      if (!user || !goal || !final) throw new Error("Missing fixture branch");
      const followup: Message = {
        id: "followup",
        author: { role: "user" },
        parent_id: user.id,
        metadata:
          selection === "missing"
            ? {}
            : { selected_sources: selection === "empty" ? [] : ["replacement-source"] },
      };
      goal.parent_id = followup.id;
      final.parent_id = goal.id;
      f.conversation.messages = [
        final,
        {
          id: "sibling",
          parent_id: user.id,
          author: { role: "user" },
          metadata: { selected_sources: ["unrelated-source"] },
        },
        goal,
        followup,
        user,
      ];
      expect(await f.run()).toEqual({ outcome: "sent" });
      expect(
        f.request.mock.calls[0]?.[2].requestBody.messages.at(-1)?.metadata?.selected_sources,
      ).toEqual(
        selection === "missing"
          ? ["selected-source"]
          : selection === "empty"
            ? []
            : ["replacement-source"],
      );
    },
  );

  it.each(["missing", "empty", "replacement"])(
    "preserves native tool system hints through prepare and send when the latest hints are %s",
    async (selection) => {
      const f = fixture();
      const [user, goal, final] = f.conversation.messages;
      if (!user || !goal || !final) throw new Error("Missing fixture branch");
      user.metadata = { system_hints: ["connector:original", "reason"] };
      const followup: Message = {
        id: "followup",
        author: { role: "user" },
        parent_id: user.id,
        metadata:
          selection === "missing"
            ? {}
            : { system_hints: selection === "empty" ? [] : ["connector:replacement"] },
      };
      goal.parent_id = followup.id;
      final.parent_id = goal.id;
      f.conversation.messages = [
        final,
        {
          id: "sibling",
          parent_id: user.id,
          author: { role: "user" },
          metadata: { system_hints: ["connector:unrelated"] },
        },
        goal,
        followup,
        user,
      ];
      const expected =
        selection === "missing"
          ? ["connector:original", "reason"]
          : selection === "empty"
            ? []
            : ["connector:replacement"];
      expect(await f.run()).toEqual({ outcome: "sent" });
      expect(f.safePost.mock.calls[0]?.[1]).toMatchObject({
        requestBody: { system_hints: expected },
      });
      const body = f.request.mock.calls[0]?.[2].requestBody;
      expect(body?.system_hints).toEqual(expected);
      expect(body?.messages.at(-1)?.metadata?.system_hints).toEqual(expected);
      expect(body?.messages.at(-1)?.content?.parts).toEqual([goalContinuationPrompt(goalId)]);
    },
  );

  it("does not read older pages when the current-turn projection advertises history", async () => {
    const f = fixture();
    Object.assign(f.conversation, {
      page_info: { has_previous_page: true, start_cursor: "older" },
    });
    expect(await f.run()).toEqual({ outcome: "sent" });
    expect(f.safeGet).toHaveBeenCalledTimes(4);
    expect(new Set(f.safeGet.mock.calls.map(([path]) => path))).toEqual(
      new Set([`/conversations/${id}`]),
    );
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("checks the live branch again after native preparation", async () => {
    const f = fixture();
    f.prepare.mockImplementationOnce(async () => {
      f.conversation.messages.push({ id: "new-user", author: { role: "user" } });
      f.conversation.current_node = "new-user";
      return {};
    });
    expect(await f.run()).toEqual({ outcome: "superseded" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("uses the actual trailing thinking parent while proving the final of that same turn", async () => {
    const f = fixture();
    f.conversation.messages.push({
      id: "thinking",
      author: { role: "assistant" },
      metadata: {
        is_thinking_preamble_message: true,
        working_turn_id: "turn",
        turn_exchange_id: "exchange",
      },
    });
    f.conversation.current_node = "thinking";
    expect(await f.run()).toEqual({ outcome: "sent" });
    expect(f.request.mock.calls[0]?.[2].requestBody.parent_message_id).toBe("thinking");
  });

  it("preserves an uncertain dispatch across renderer restart and does not resend", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("connection_lost"));
    await expect(f.run()).rejects.toThrow("ORACLE_GOAL_SEND_UNCONFIRMED");
    expect(await f.run()).toEqual({ outcome: "send_unconfirmed" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each(["initial_read", "prerequisites", "prepared_read"] as const)(
    "keeps a new draft retryable when %s fails before any send",
    async (stage) => {
      const f = fixture();
      const error = new Error(`CONNECTION_RESET_${stage}`);
      if (stage === "initial_read") f.safeGet.mockRejectedValueOnce(error);
      else if (stage === "prerequisites") f.prepare.mockRejectedValueOnce(error);
      else {
        f.safeGet.mockResolvedValueOnce(structuredClone(f.conversation));
        f.safeGet.mockResolvedValueOnce(structuredClone(f.conversation));
        f.safeGet.mockRejectedValueOnce(error);
      }
      expect(await f.run()).toEqual({ outcome: "send_not_started", error: error.message });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.storage.get(`__omnicodexGoalDispatches:${connector}`)).toBeUndefined();
      expect(await f.run()).toEqual({ outcome: "sent" });
      expect(f.request).toHaveBeenCalledOnce();
    },
  );

  it("does not turn a failed read of a previously journaled send into an unsent draft", async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(new Error("connection_lost"));
    await expect(f.run()).rejects.toThrow("ORACLE_GOAL_SEND_UNCONFIRMED");
    const journal = f.storage.get(`__omnicodexGoalDispatches:${connector}`);
    f.safeGet.mockRejectedValueOnce(new Error("READ_CONNECTION_RESET"));
    await expect(f.run()).rejects.toThrow("READ_CONNECTION_RESET");
    expect(f.storage.get(`__omnicodexGoalDispatches:${connector}`)).toBe(journal);
    expect(await f.run()).toEqual({ outcome: "send_unconfirmed" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("requires the exact connector's actual Goal result", async () => {
    const f = fixture();
    const resource = f.conversation.messages[1]?.metadata?.invoked_resource;
    if (!resource) throw new Error("Missing tool resource");
    resource.resource_uri = "/asdk_app_other/link_test/omnicodex__goal_get";
    expect(await f.run()).toEqual({ outcome: "goal_binding_unverified" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("proves an unjournaled dispatch never started and does not mutate during inspection", async () => {
    const f = fixture();
    expect(await f.run({ ...target, operation: "inspect" })).toEqual({
      outcome: "send_not_started",
    });
    expect(
      await f.run({
        ...target,
        operation: "inspect",
        draft: { ...target.draft, state: "ready" },
      }),
    ).toEqual({ outcome: "ready" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.safePost).not.toHaveBeenCalled();
    await expect(f.run({ ...target, draft: { ...target.draft, state: "ready" } })).rejects.toThrow(
      "NOT_CLAIMED",
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it("stops during the shared account cooldown without another read", async () => {
    const f = fixture();
    f.runtime.backoffUntil = Date.now() + 60_000;
    expect(await f.run()).toEqual({ outcome: "rate_limited" });
    expect(f.safeGet).not.toHaveBeenCalled();
    expect(f.safePost).not.toHaveBeenCalled();
  });

  it("retains an HTTP rejection and shares its cooldown with the approval runtime", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ status: 429 });
    expect(await f.run()).toMatchObject({
      outcome: "send_rejected",
      error: "ORACLE_GOAL_SEND_HTTP_429",
    });
    expect(await f.run()).toMatchObject({ outcome: "rate_limited" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("does not submit a model turn when native conversation preparation is rejected", async () => {
    const f = fixture();
    f.safePost.mockRejectedValueOnce({ status: 429 });
    expect(await f.run()).toMatchObject({
      outcome: "rate_limited",
      error: "ORACLE_GOAL_PREPARE_HTTP_429",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ outcome: "rate_limited" });
  });

  it.each(["600", "Tue, 08 Sep 2026 00:10:00 GMT"])(
    "returns and persists the actual Goal 429 deadline for Retry-After %s without escalating cached reads",
    async (retryAfter) => {
      const f = fixture();
      const now = Date.parse("2026-09-08T00:00:00Z");
      Object.assign(f.context, {
        Date: class extends Date {
          static override now() {
            return now;
          }
        },
      });
      const key = `__omnicodexOracleServerApprovalV2:${connector}`;
      f.storage.set(key, JSON.stringify({ version: 8, backoffUntil: 0 }));
      f.safePost.mockRejectedValueOnce({
        status: 429,
        headers: new Headers({
          "retry-after": retryAfter,
          "x-request-id": "goal-request",
          authorization: "not-forwarded",
        }),
      });
      const failed = await f.run();
      expect(failed).toMatchObject({
        outcome: "rate_limited",
        error: "ORACLE_GOAL_PREPARE_HTTP_429",
        rateLimit: {
          status: 429,
          operation: "goal_prepare",
          retryAtUnixMs: now + 600_000,
          serverRetryAtUnixMs: now + 600_000,
          observedAtUnixMs: now,
          localBackoffMs: 30_000,
          backoffSource: "server_retry_after",
          responseHeaders: { "retry-after": retryAfter, "x-request-id": "goal-request" },
        },
      });
      expect(failed.rateLimit.responseHeaders.authorization).toBeUndefined();
      const persisted = f.storage.get(key);
      expect(JSON.parse(persisted ?? "null").lastRateLimit).toEqual(failed.rateLimit);
      const reads = f.safeGet.mock.calls.length;
      expect((await f.run()).rateLimit).toEqual(failed.rateLimit);
      expect(f.storage.get(key)).toEqual(persisted);
      expect(f.safeGet).toHaveBeenCalledTimes(reads);
      expect(f.safePost).toHaveBeenCalledOnce();
    },
  );

  it("does not compound local pacing on repeated 429s and retries the same unsent draft", async () => {
    const f = fixture();
    let now = Date.parse("2026-09-08T00:00:00Z");
    Object.assign(f.context, {
      Date: class extends Date {
        static override now() {
          return now;
        }
      },
    });
    Object.assign(f.runtime, { backoffMs: 3_600_000 });
    for (let attempt = 0; attempt < 3; attempt++) {
      f.safePost.mockRejectedValueOnce({ status: 429 });
      expect(await f.run()).toMatchObject({
        outcome: "rate_limited",
        rateLimit: { retryAtUnixMs: now + 30_000, localBackoffMs: 30_000 },
      });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.storage.get(`__omnicodexGoalDispatches:${connector}`)).toBeUndefined();
      now += 30_000;
    }
    expect(await f.run()).toMatchObject({ outcome: "sent" });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each([undefined, 600_000])(
    "retires old local inflation while preserving server deadline %s",
    async (serverWaitMs) => {
      const f = fixture();
      const observedAtUnixMs = Date.parse("2026-09-08T00:00:00Z");
      const now = observedAtUnixMs + 60_000;
      Object.assign(f.context, {
        Date: class extends Date {
          static override now() {
            return now;
          }
        },
      });
      Object.assign(f.runtime, {
        backoffUntil: observedAtUnixMs + 3_600_000,
        backoffMs: 3_600_000,
        lastRateLimit: {
          observedAtUnixMs,
          retryAtUnixMs: observedAtUnixMs + 3_600_000,
          localBackoffMs: 3_600_000,
          backoffSource: "local_backoff",
          ...(serverWaitMs === undefined
            ? {}
            : { serverRetryAtUnixMs: observedAtUnixMs + serverWaitMs }),
        },
      });
      const key = `__omnicodexOracleServerApprovalV2:${connector}`;
      f.storage.set(key, JSON.stringify({ version: 8 }));
      expect(await f.run()).toMatchObject({
        outcome: serverWaitMs === undefined ? "sent" : "rate_limited",
        rateLimit: {
          retryAtUnixMs: observedAtUnixMs + (serverWaitMs ?? 30_000),
          localBackoffMs: 30_000,
          backoffSource: serverWaitMs === undefined ? "local_backoff" : "server_retry_after",
        },
      });
      expect(JSON.parse(f.storage.get(key) ?? "null").backoffUntil).toBe(
        observedAtUnixMs + (serverWaitMs ?? 30_000),
      );
      expect(f.request).toHaveBeenCalledTimes(serverWaitMs === undefined ? 1 : 0);
    },
  );

  it("returns a read 429 snapshot without preparing or sending a turn", async () => {
    const f = fixture();
    f.safeGet.mockRejectedValueOnce({ status: 429, message: "Too many requests" });
    expect(await f.run()).toMatchObject({
      outcome: "rate_limited",
      error: "Too many requests",
      rateLimit: { status: 429, operation: "goal_current_turn_read" },
    });
    expect(f.safePost).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
  });

  it("recognizes only the fixed operation and disallows execution on an unowned page", () => {
    const expression = oracleGoalContinuationExpression(connector, target);
    expect(isOracleGoalContinuationExpression(expression, connector)).toBe(true);
    expect(isOracleGoalContinuationExpression(expression, "asdk_app_other")).toBe(false);
    expect(isOracleGoalContinuationExpression(`${expression};arbitrary()`, connector)).toBe(false);
    expect(
      isOracleGoalContinuationExpression(
        expression.replace(
          JSON.stringify(goalContinuationPrompt(goalId)),
          JSON.stringify("different"),
        ),
        connector,
      ),
    ).toBe(false);
    const transport = new ChatGptLoopbackCdpTransport({ endpoint: "http://127.0.0.1:9222" });
    expect(() =>
      transport.assertAllowedCommand(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
        "unowned",
      ),
    ).toThrow();
  });
});
