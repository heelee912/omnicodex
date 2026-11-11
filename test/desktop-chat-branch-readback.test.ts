import { expect, it, vi } from "vitest";
import { readDesktopChatBranchCompletion } from "../src/infrastructure/windows/desktop-chat-goal-continuation.js";

const page = (items: unknown[], nextCursor?: string) => ({
  thread: { id: "conversation", kind: "chatgpt", status: { type: "idle" } },
  turns: [{ status: "completed", items }],
  page: { order: "newest_first", hasMore: nextCursor !== undefined, nextCursor },
});
it("keeps a bare notification unresolved when native current branch still ends at the old anchor", async () => {
  const read = vi.fn(async () => page([{ type: "agentMessage", id: "old" }]));
  expect(
    await readDesktopChatBranchCompletion(
      read,
      "conversation",
      "old",
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(1);
});
it("pages the native current branch to prove a newer completed reply follows the anchor", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(
      page(
        [
          { type: "userMessage", id: "next-user" },
          { type: "agentMessage", id: "new" },
        ],
        "older",
      ),
    )
    .mockResolvedValueOnce(page([{ type: "agentMessage", id: "anchor" }]));
  expect(
    await readDesktopChatBranchCompletion(
      read,
      "conversation",
      "anchor",
      new AbortController().signal,
    ),
  ).toEqual({ finalMessageId: "new", ancestorMessageIds: ["next-user", "anchor"] });
  expect(read.mock.calls[1]?.[0]).toMatchObject({ cursor: "older", threadId: "conversation" });
});
it("does not accept a branch without its previous anchor or while the native thread is active", async () => {
  const unrelated = page([{ type: "agentMessage", id: "other-branch" }]);
  expect(
    await readDesktopChatBranchCompletion(
      async () => unrelated,
      "conversation",
      "anchor",
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(
    await readDesktopChatBranchCompletion(
      async () => ({ ...unrelated, thread: { ...unrelated.thread, status: { type: "active" } } }),
      "conversation",
      "anchor",
      new AbortController().signal,
    ),
  ).toBeUndefined();
});
