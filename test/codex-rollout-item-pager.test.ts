import { appendFile, type FileHandle, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexRolloutItemPager } from "../src/infrastructure/runtime/codex-rollout-item-pager.js";

describe("CodexRolloutItemPager", () => {
  it.each(["long-header", "payload-first"])(
    "preserves turn attribution with %s JSON records",
    async (layout) => {
      const directory = await mkdtemp(join(tmpdir(), "omnicodex-rollout-layout-"));
      const path = join(directory, "rollout.jsonl");
      const turnId = 'turn-"quoted"-한글';
      const line = (type: string, payload: Record<string, unknown>) =>
        `${JSON.stringify(
          layout === "long-header"
            ? { type, metadata: "header".repeat(300), payload }
            : { payload, type },
        )}\r\n`;
      const first = { type: "message", id: "first", content: [] };
      const second = { type: "function_call_output", output: "large 한글".repeat(400_000) };
      try {
        await writeFile(
          path,
          [
            line("event_msg", { type: "task_started", turn_id: turnId }),
            line("response_item", first),
            line("event_msg", { type: "task_complete", turn_id: "another-turn" }),
            line("response_item", second),
            line("event_msg", { type: "task_complete", turn_id: turnId }),
            line("response_item", { type: "message", id: "outside-turn" }),
          ].join(""),
        );
        const pager = new CodexRolloutItemPager();
        const page = await pager.readTurnPage({ rolloutPath: path, turnId });
        expect(page.items).toHaveLength(2);
        expect(page.items).toEqual([first, second]);
        expect(page.page).toMatchObject({ totalItems: 2, nextItemOffset: null });
        await appendFile(path, line("turn_context", { turn_id: "next-turn" }));
        const appended = line("response_item", { type: "message", id: "appended" });
        await appendFile(path, appended.slice(0, -1));
        expect(
          (await pager.readTurnPage({ rolloutPath: path, turnId: "next-turn" })).items,
        ).toEqual([]);
        await appendFile(path, "\n");
        expect(
          (await pager.readTurnPage({ rolloutPath: path, turnId: "next-turn" })).items,
        ).toEqual([{ type: "message", id: "appended" }]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("returns more than 64 items when the caller omits a limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-rollout-unbounded-"));
    const path = join(directory, "rollout.jsonl");
    const line = (type: string, payload: Record<string, unknown>) =>
      `${JSON.stringify({ timestamp: "2026-09-03T00:00:00.000Z", type, payload })}\n`;
    try {
      await writeFile(
        path,
        [
          line("event_msg", { type: "task_started", turn_id: "turn-70" }),
          ...Array.from({ length: 70 }, (_, index) =>
            line("response_item", {
              type: "message",
              id: `item-${String(index)}`,
              role: "assistant",
              content: [],
            }),
          ),
          line("event_msg", { type: "task_complete", turn_id: "turn-70" }),
        ].join(""),
        "utf8",
      );

      const page = await new CodexRolloutItemPager().readTurnPage({
        rolloutPath: path,
        turnId: "turn-70",
      });
      expect(page.items).toHaveLength(70);
      expect(page.items.at(64)).toMatchObject({ id: "item-64" });
      expect(page.page).toMatchObject({
        limit: null,
        callerSelectedLimit: false,
        returnedItems: 70,
        omittedItems: 0,
        selection: "all",
        nextItemOffset: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not duplicate committed items when a malformed later line is repaired", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-rollout-repair-"));
    const path = join(directory, "rollout.jsonl");
    const records = [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn" } }),
      JSON.stringify({ type: "response_item", payload: { id: "before" } }),
      '{"x": ?}',
      JSON.stringify({ type: "response_item", payload: { id: "after" } }),
    ];
    try {
      await writeFile(path, `${records.join("\n")}\n`);
      const pager = new CodexRolloutItemPager();
      await expect(pager.readTurnPage({ rolloutPath: path, turnId: "turn" })).rejects.toThrow();
      records[2] = '{"x": 1}';
      await writeFile(path, `${records.join("\n")}\n`);
      expect((await pager.readTurnPage({ rolloutPath: path, turnId: "turn" })).items).toEqual([
        { id: "before" },
        { id: "after" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pages large turn items losslessly from the append-only rollout and indexes appends", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-rollout-page-"));
    const path = join(directory, "rollout.jsonl");
    const line = (type: string, payload: Record<string, unknown>) =>
      `${JSON.stringify({ timestamp: "2026-08-30T00:00:00.000Z", type, payload })}\n`;
    try {
      await writeFile(
        path,
        [
          line("session_meta", { id: "thread-a" }),
          line("event_msg", { type: "task_started", turn_id: "turn-a" }),
          line("response_item", { type: "message", id: "item-1", role: "user", content: [] }),
          line("response_item", {
            type: "custom_tool_call_output",
            id: "item-window",
            call_id: "call-window",
            output: "w".repeat(100_000),
          }),
          line("response_item", {
            type: "custom_tool_call_output",
            id: "item-2",
            call_id: "call-2",
            output: "x".repeat(600_000),
          }),
          line("response_item", { type: "message", id: "item-3", role: "assistant", content: [] }),
          line("event_msg", { type: "task_complete", turn_id: "turn-a" }),
          line("event_msg", { type: "task_started", turn_id: "turn-b" }),
          line("response_item", { type: "message", id: "item-b", role: "user", content: [] }),
        ].join(""),
        "utf8",
      );

      const pager = new CodexRolloutItemPager();
      const completeByDefault = await pager.readTurnPage({
        rolloutPath: path,
        turnId: "turn-a",
      });
      expect(completeByDefault.items).toMatchObject([
        { id: "item-1" },
        { id: "item-window" },
        { id: "item-2" },
        { id: "item-3" },
      ]);
      expect(completeByDefault.page).toMatchObject({
        limit: null,
        totalItems: 4,
        returnedItems: 4,
        selection: "all",
        nextItemOffset: null,
      });
      expect(completeByDefault.page.returnedBytes).toBeGreaterThan(700_000);

      const first = await pager.readTurnPage({
        rolloutPath: path,
        turnId: "turn-a",
        maxBytes: 96 * 1024,
      });
      expect(first.items).toMatchObject([{ id: "item-1" }]);
      expect(first.page).toMatchObject({
        limit: null,
        totalItems: 4,
        returnedItems: 1,
        selection: "transport_window",
        nextItemOffset: 1,
      });
      const secondOffset = first.page.nextItemOffset;
      expect(secondOffset).not.toBeNull();

      const second = await pager.readTurnPage({
        rolloutPath: path,
        turnId: "turn-a",
        maxBytes: 96 * 1024,
        ...(secondOffset === null ? {} : { offset: secondOffset }),
      });
      expect(second.items).toMatchObject([{ id: "item-window" }]);
      expect(second.page.nextItemOffset).toBe(2);

      const third = await pager.readTurnPage({
        rolloutPath: path,
        turnId: "turn-a",
        offset: 2,
        maxBytes: 96 * 1024,
      });
      expect(third.items).toMatchObject([{ id: "item-2" }]);
      expect(third.page.nextItemOffset).toBe(3);

      const complete = await pager.readTurnPage({
        rolloutPath: path,
        turnId: "turn-a",
        limit: 4,
      });
      expect(complete.items).toMatchObject([
        { id: "item-1" },
        { id: "item-window" },
        { id: "item-2" },
        { id: "item-3" },
      ]);
      expect(complete.page).toMatchObject({
        callerSelectedLimit: true,
        returnedItems: 4,
        nextItemOffset: null,
      });

      const callerCountWithinWireWindow = await pager.readTurnPage({
        rolloutPath: path,
        turnId: "turn-a",
        limit: 4,
        maxBytes: 150_000,
      });
      expect(callerCountWithinWireWindow.items).toMatchObject([
        { id: "item-1" },
        { id: "item-window" },
      ]);
      expect(callerCountWithinWireWindow.page).toMatchObject({
        callerSelectedLimit: true,
        limit: 4,
        returnedItems: 2,
        nextItemOffset: 2,
      });

      const remaining = await pager.readTurnPage({
        rolloutPath: path,
        turnId: "turn-a",
        offset: 2,
      });
      expect(remaining.items).toMatchObject([{ id: "item-2" }, { id: "item-3" }]);
      expect(remaining.page).toMatchObject({
        limit: null,
        returnedItems: 2,
        selection: "all",
        nextItemOffset: null,
      });

      await appendFile(
        path,
        [
          line("response_item", { type: "message", id: "item-b2", role: "assistant", content: [] }),
          line("event_msg", { type: "task_complete", turn_id: "turn-b" }),
        ].join(""),
        "utf8",
      );
      const appended = await pager.readTurnPage({ rolloutPath: path, turnId: "turn-b", limit: 5 });
      expect(appended.items).toMatchObject([{ id: "item-b" }, { id: "item-b2" }]);
      expect(appended.page.nextItemOffset).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("continues legal short reads until one indexed rollout item is complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "omnicodex-rollout-short-read-"));
    const path = join(directory, "rollout.jsonl");
    const line = (type: string, payload: Record<string, unknown>) =>
      `${JSON.stringify({ timestamp: "2026-09-03T00:00:00.000Z", type, payload })}\n`;
    await writeFile(
      path,
      [
        line("event_msg", { type: "task_started", turn_id: "turn-short" }),
        line("response_item", {
          type: "custom_tool_call_output",
          id: "complete-item",
          call_id: "call-short",
          output: "complete-output".repeat(32),
        }),
        line("event_msg", { type: "task_complete", turn_id: "turn-short" }),
      ].join(""),
      "utf8",
    );

    const probe = await open(path, "r");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: FileHandle["read"] };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    const readSpy = vi.spyOn(fileHandlePrototype, "read").mockImplementation(function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): ReturnType<FileHandle["read"]> {
      return Reflect.apply(originalRead, this, [buffer, offset, Math.min(length, 11), position]);
    } as FileHandle["read"]);

    try {
      const page = await new CodexRolloutItemPager().readTurnPage({
        rolloutPath: path,
        turnId: "turn-short",
      });
      expect(page.items).toMatchObject([
        { id: "complete-item", output: "complete-output".repeat(32) },
      ]);
      expect(page.page.nextItemOffset).toBeNull();
      expect(readSpy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
