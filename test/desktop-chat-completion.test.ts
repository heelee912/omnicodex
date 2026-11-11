import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopChatConversationSources,
  desktopChatAccountSourceId,
  desktopChatCompletionCandidates,
  verifyDesktopChatCompletion,
} from "../src/infrastructure/windows/desktop-chat-completion.js";

const conversationId = "6a9d8c74-a448-83e8-843e-41e6ac46f1bf";
const conversationUrl = `https://chatgpt.com/c/${conversationId}`;
const candidate = { conversationUrl, finalMessageId: "final", streamTurnId: "native-stream-turn" };
const principal = { accountId: "account-one", userId: "user-one" };
const current = (id = "final", status = "idle") => ({
  thread: { id: conversationId, kind: "chatgpt", status: { type: status } },
  page: { order: "newest_first" },
  turns: [
    {
      id: "different-native-app-turn",
      status: "completed",
      items: [{ id, type: "agentMessage", text: "done" }],
    },
  ],
});
const dependencies = () => ({
  readPrincipal: vi.fn(async () => principal),
  hasConversationSource: vi.fn(async () => true),
  readThread: vi.fn(async () => current()),
});

describe("account-bound desktop Chat completion", () => {
  it("requires a final-channel message and preserves the independent native stream identity", () => {
    const event = {
      source: {
        endpoint: "http://127.0.0.1:29341",
        processId: 1,
        startedAtIso: "2026-09-07T00:00:00Z",
      },
      targetId: "app",
      conversationUrl,
      notification: {
        type: "conversation-update" as const,
        payload: {
          conversation_id: conversationId,
          turn_id: "native-stream-turn",
          update_type: "add-messages",
          update_content: {
            messages: [
              {
                id: "synthetic",
                author: { role: "assistant" },
                status: "finished_successfully",
                end_turn: true,
                channel: null,
              },
              {
                id: "final",
                author: { role: "assistant" },
                status: "finished_successfully",
                end_turn: true,
                channel: "final",
              },
            ],
          },
        },
      },
    };
    expect(desktopChatCompletionCandidates(event)).toEqual([candidate]);
    expect(
      desktopChatCompletionCandidates({
        ...event,
        notification: {
          type: "conversation-turn-complete",
          payload: { conversation_id: conversationId },
        },
      }),
    ).toEqual([]);
    expect(
      desktopChatCompletionCandidates({
        ...event,
        notification: {
          ...event.notification,
          payload: { ...event.notification.payload, conversation_id: "other" },
        },
      }),
    ).toEqual([]);
  });

  it("joins auth, the exact catalog source, and native final read without treating app turn ids as stream ids", async () => {
    const deps = dependencies();
    const signal = new AbortController().signal;
    expect(await verifyDesktopChatCompletion(candidate, deps, signal)).toEqual({
      outcome: "verified",
      principal,
      accountSourceId: "chatgpt:account-one:user-one",
      completion: candidate,
    });
    expect(deps.hasConversationSource).toHaveBeenCalledExactlyOnceWith(
      "chatgpt:account-one:user-one",
      conversationId,
    );
    expect(deps.readThread).toHaveBeenCalledExactlyOnceWith(conversationId, signal);
    expect(deps.readPrincipal).toHaveBeenCalledTimes(2);
  });

  it("does not accept an older cached response merely because the app reports idle", async () => {
    const deps = dependencies();
    deps.readThread.mockResolvedValue(current("old-final"));
    expect(
      await verifyDesktopChatCompletion(candidate, deps, new AbortController().signal),
    ).toEqual({
      outcome: "awaiting_transcript",
      readbackOutcome: "anchor_not_visible",
    });
    deps.readThread.mockResolvedValue(current("final", "active"));
    expect(
      await verifyDesktopChatCompletion(candidate, deps, new AbortController().signal),
    ).toEqual({
      outcome: "awaiting_transcript",
      readbackOutcome: "generating",
    });
  });

  it("rejects an account change even when the returned final matches", async () => {
    const deps = dependencies();
    deps.readPrincipal
      .mockResolvedValueOnce(principal)
      .mockResolvedValueOnce({ accountId: "account-two", userId: "user-two" });
    expect(
      await verifyDesktopChatCompletion(candidate, deps, new AbortController().signal),
    ).toEqual({ outcome: "account_changed" });
  });

  it("does not read an event's conversation under a mismatching native account source", async () => {
    const deps = dependencies();
    deps.hasConversationSource.mockResolvedValue(false);
    expect(
      await verifyDesktopChatCompletion(candidate, deps, new AbortController().signal),
    ).toEqual({ outcome: "conversation_source_mismatch" });
    expect(deps.readThread).not.toHaveBeenCalled();
    expect(() => desktopChatAccountSourceId({ accountId: "account:user", userId: "one" })).toThrow(
      "SOURCE_INVALID",
    );
  });

  it("reads only the exact catalog identity and preserves the native database", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnicodex-desktop-completion-"));
    const directory = join(root, "sqlite");
    const path = join(directory, "codex-dev.db");
    await mkdir(directory);
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, PRIMARY KEY(host_id, thread_id))",
    );
    db.prepare("INSERT INTO local_thread_catalog VALUES (?, ?)").run(
      "chatgpt:account-one:user-one",
      conversationId,
    );
    db.close();
    try {
      const sources = new DesktopChatConversationSources(root);
      expect(
        await sources.hasConversationSource("chatgpt:account-one:user-one", conversationId),
      ).toBe(true);
      expect(
        await sources.hasConversationSource("chatgpt:account-two:user-two", conversationId),
      ).toBe(false);
      expect(await sources.hasConversationSource("chatgpt:account-one:user-one", "other")).toBe(
        false,
      );
    } finally {
      await rm(path);
      await rmdir(directory);
      await rmdir(root);
    }
  });
});
