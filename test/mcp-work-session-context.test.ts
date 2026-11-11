import { describe, expect, it } from "vitest";
import type { DurableWorkSessionBinding } from "../src/infrastructure/mcp/durable-work-session-store.js";
import {
  callerProvenanceFromRequestMeta,
  chatGptConversationUrlFromRequestMeta,
  McpWorkSessionContext,
  nativeRequestIdentityMatcher,
  openAiSessionIdentityKindFromRequestMeta,
  workSessionRequestBinding,
  workSessionRequestIncludesToolCall,
  workSessionRequestMeta,
} from "../src/infrastructure/mcp/mcp-work-session-context.js";

describe("McpWorkSessionContext", () => {
  it("matches only one exact request ID header without folding case or multiple values", () => {
    const match = nativeRequestIdentityMatcher({ requestIdHeader: "Native-Request-ID" });
    expect(match("Native-Request-ID")).toBe(true);
    for (const candidate of ["native-request-id", " Native-Request-ID", "Native-Request-ID "])
      expect(match(candidate)).toBe(false);
    for (const header of ["", "one,two", "one, two", " one", ["one"], ["one", "two"]]) {
      const invalid = nativeRequestIdentityMatcher({ requestIdHeader: header });
      expect(invalid("one")).toBe(false);
      expect(invalid(header)).toBe(false);
    }
  });
  it("compares exact request identities without treating a session or account as a request", () => {
    const trace = "0123456789abcdef0123456789abcdef";
    const match = nativeRequestIdentityMatcher({
      traceparent: `00-${trace}-0123456789abcdef-01`,
      metadata: {
        "openai/requestId": "native-request",
        "openai/toolInvocationId": "native-call",
        "openai/session": "session",
        "openai/subject": "person",
      },
    });
    expect(match(trace)).toBe(true);
    expect(match("native-request")).toBe(true);
    expect(match("native-call")).toBe(true);
    for (const value of ["session", "person", ` ${trace}`, trace.toUpperCase(), "", undefined, 1])
      expect(match(value)).toBe(false);
    expect(
      nativeRequestIdentityMatcher({
        traceparent: "00-00000000000000000000000000000000-0123456789abcdef-01",
      })("00000000000000000000000000000000"),
    ).toBe(false);
  });

  it("keeps native request comparators isolated across concurrent attribution contexts", async () => {
    const context = new McpWorkSessionContext();
    await Promise.all(
      ["first", "second"].map(async (id) =>
        context.runRequest(
          undefined,
          {
            principalBindingSha256: id,
            matchesNativeRequestId: nativeRequestIdentityMatcher({
              metadata: { "openai/requestId": id },
            }),
          },
          async () => {
            await Promise.resolve();
            const attribution = context.currentAttribution();
            expect(attribution?.matchesNativeRequestId?.(id)).toBe(true);
            expect(attribution?.matchesNativeRequestId?.(id === "first" ? "second" : "first")).toBe(
              false,
            );
            expect(JSON.stringify(attribution)).not.toContain("matchesNativeRequestId");
          },
        ),
      ),
    );
    expect(context.currentAttribution()).toBeUndefined();
  });
  it("keeps concurrent request bindings isolated and restores the outer binding", async () => {
    const context = new McpWorkSessionContext();
    const first = binding("wsb1_first");
    const second = binding("wsb1_second");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await context.run(first, async () => {
      const concurrent = context.run(second, async () => {
        expect(context.current()).toBe(second);
        releaseFirst();
        await Promise.resolve();
        expect(context.current()).toBe(second);
      });
      await firstGate;
      expect(context.current()).toBe(first);
      await concurrent;
      expect(context.current()).toBe(first);
    });
    expect(context.current()).toBeUndefined();
  });

  it("extracts only an object params._meta", () => {
    const meta = { "io.modelcontextprotocol/related-task": { taskId: "task" } };
    expect(workSessionRequestMeta({ method: "tools/call", params: { _meta: meta } })).toBe(meta);
    expect(workSessionRequestMeta({ method: "tools/call", params: { _meta: [] } })).toBeUndefined();
    expect(workSessionRequestMeta({ method: "tools/call", params: null })).toBeUndefined();
    expect(
      workSessionRequestMeta({ method: "initialize", params: { _meta: meta } }),
    ).toBeUndefined();
  });

  it("derives only exact canonical ChatGPT conversation routes", () => {
    const conversationId = "6A96D948-C6F8-83E8-83C5-E265BCBA2930";
    const expected = "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930";
    expect(chatGptConversationUrlFromRequestMeta({ "openai/session": conversationId })).toBe(
      expected,
    );
    expect(
      chatGptConversationUrlFromRequestMeta({
        "openai/session": `${expected}/?model=pro#bottom`,
      }),
    ).toBe(expected);
    expect(
      chatGptConversationUrlFromRequestMeta({
        "openai/session": "WEB:A6B0D2F0-7590-4197-A40C-29A6DE66DA22",
      }),
    ).toBe("https://chatgpt.com/c/WEB:a6b0d2f0-7590-4197-a40c-29a6de66da22");
    expect(
      chatGptConversationUrlFromRequestMeta({
        "openai/session":
          "https://chatgpt.com/c/WEB:A6B0D2F0-7590-4197-A40C-29A6DE66DA22?model=pro#bottom",
      }),
    ).toBe("https://chatgpt.com/c/WEB:a6b0d2f0-7590-4197-a40c-29a6de66da22");
    expect(
      chatGptConversationUrlFromRequestMeta({
        "openai/session": "observation-anonymous-chat-session",
      }),
    ).toBeUndefined();
    expect(
      chatGptConversationUrlFromRequestMeta({
        "openai/session": "https://example.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930",
      }),
    ).toBeUndefined();
  });

  it("classifies the openai session shape without exposing its value", () => {
    expect(openAiSessionIdentityKindFromRequestMeta(undefined)).toBe("absent");
    expect(openAiSessionIdentityKindFromRequestMeta({ "openai/session": 42 })).toBe("invalid");
    expect(openAiSessionIdentityKindFromRequestMeta({ "openai/session": " " })).toBe("invalid");
    expect(
      openAiSessionIdentityKindFromRequestMeta({
        "openai/session": "WEB:A6B0D2F0-7590-4197-A40C-29A6DE66DA22",
      }),
    ).toBe("conversation_id");
    expect(
      openAiSessionIdentityKindFromRequestMeta({
        "openai/session": "https://chatgpt.com/c/6a96d948-c6f8-83e8-83c5-e265bcba2930?model=pro",
      }),
    ).toBe("conversation_url");
    expect(
      openAiSessionIdentityKindFromRequestMeta({
        "openai/session": "opaque-but-authenticated-chatgpt-session",
      }),
    ).toBe("opaque");
  });

  it("classifies ChatGPT conversation provenance without accepting a tool argument claim", () => {
    expect(
      callerProvenanceFromRequestMeta({
        "openai/session": "opaque-but-authenticated-chatgpt-session",
      }),
    ).toBe("chatgpt_conversation");
    expect(
      callerProvenanceFromRequestMeta({
        "io.modelcontextprotocol/related-task": { taskId: "local-client" },
      }),
    ).toBe("unattributed_mcp_client");
    expect(callerProvenanceFromRequestMeta(undefined)).toBe("unattributed_mcp_client");
  });

  it("keeps request attribution isolated across concurrent calls", async () => {
    const context = new McpWorkSessionContext();
    const first = binding("wsb1_first-attribution");
    const second = binding("wsb1_second-attribution");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const mutableDigests = [{ name: "header:x-request-id", valueHmac: "first-hmac" }];

    await context.runRequest(
      first,
      {
        principalBindingSha256: "a".repeat(64),
        transportIdentityDigests: mutableDigests,
      },
      async () => {
        mutableDigests[0] = { name: "changed", valueHmac: "changed" };
        const concurrent = context.runRequest(
          second,
          {
            principalBindingSha256: "b".repeat(64),
            invocationIdSha256: "c".repeat(64),
          },
          async () => {
            expect(context.current()).toBe(second);
            expect(context.currentAttribution()).toMatchObject({
              principalBindingSha256: "b".repeat(64),
              invocationIdSha256: "c".repeat(64),
            });
            releaseFirst();
            await Promise.resolve();
            expect(context.current()).toBe(second);
          },
        );
        await firstGate;
        expect(context.current()).toBe(first);
        expect(context.currentAttribution()?.transportIdentityDigests).toEqual([
          { name: "header:x-request-id", valueHmac: "first-hmac" },
        ]);
        await concurrent;
      },
    );
    expect(context.current()).toBeUndefined();
    expect(context.currentAttribution()).toBeUndefined();
  });

  it("binds a same-conversation batch and rejects mixed conversation metadata", () => {
    const firstMeta = {
      "io.modelcontextprotocol/related-task": { taskId: "conversation-a", namespace: "web" },
      progressToken: 1,
    };
    const sameConversation = [
      { method: "tools/call", params: { _meta: firstMeta } },
      {
        method: "tools/call",
        params: {
          _meta: {
            progressToken: 2,
            "io.modelcontextprotocol/related-task": {
              namespace: "supplemental-field-may-differ",
              taskId: "conversation-a",
            },
          },
        },
      },
    ];
    expect(workSessionRequestIncludesToolCall(sameConversation)).toBe(true);
    expect(workSessionRequestMeta(sameConversation)).toBe(firstMeta);
    expect(() =>
      workSessionRequestMeta([
        sameConversation[0],
        {
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/related-task": { taskId: "conversation-b" },
            },
          },
        },
      ]),
    ).toThrow("conflicting work-session metadata");
    expect(workSessionRequestIncludesToolCall([{ method: "tools/call", params: {} }])).toBe(true);
  });

  it("uses ChatGPT openai/session as the authoritative batch conversation identity", () => {
    const firstMeta = {
      "openai/session": "anonymous-chat-session-a",
      "io.modelcontextprotocol/related-task": { taskId: "turn-local-task-1" },
    };
    expect(
      workSessionRequestMeta([
        { method: "tools/call", params: { _meta: firstMeta } },
        {
          method: "tools/call",
          params: {
            _meta: {
              "openai/session": "anonymous-chat-session-a",
              "io.modelcontextprotocol/related-task": { taskId: "turn-local-task-2" },
            },
          },
        },
      ]),
    ).toBe(firstMeta);
    expect(() =>
      workSessionRequestMeta([
        { method: "tools/call", params: { _meta: firstMeta } },
        {
          method: "tools/call",
          params: { _meta: { "openai/session": "anonymous-chat-session-b" } },
        },
      ]),
    ).toThrow("conflicting work-session metadata");
  });

  it("extracts copy-safe explicit bindings and rejects mixed batches", () => {
    const expected = {
      workSessionBinding: "wsb1_same-web-conversation",
      continuationToken: "wct1_same-web-conversation",
    };
    expect(
      workSessionRequestBinding({
        method: "tools/call",
        params: { arguments: { _omnicodexSession: expected, path: "README.md" } },
      }),
    ).toEqual(expected);
    expect(
      workSessionRequestBinding({
        method: "tools/call",
        params: { arguments: { ...expected, path: "README.md" } },
      }),
    ).toEqual(expected);
    expect(() =>
      workSessionRequestBinding([
        { method: "tools/call", params: { arguments: expected } },
        {
          method: "tools/call",
          params: { arguments: { workSessionBinding: "wsb1_different" } },
        },
      ]),
    ).toThrow("conflicting explicit work-session bindings");
  });
});

function binding(workSessionBinding: string): DurableWorkSessionBinding {
  return {
    workSessionBinding,
    directGoalClaimantBinding: workSessionBinding,
    directJobOwnerBinding: workSessionBinding,
    continuationToken: `wct1_${workSessionBinding}`,
    source: "issued",
    created: true,
    journalCursor: `wsc1_${workSessionBinding}`,
    expiresAtUnixMs: 1,
  };
}
