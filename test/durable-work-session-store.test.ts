import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableWorkSessionStore,
  type DurableWorkSessionStoreOptions,
} from "../src/infrastructure/mcp/durable-work-session-store.js";

const OWNER_A = "https://issuer.example\0auth0|owner-a\0client\0omnicodex";
const OWNER_B = "https://issuer.example\0auth0|owner-b\0client\0omnicodex";
const HMAC_KEY = Buffer.from(
  "b218c3e8f5b17a7ce43b0fb30cfcdcb436645e985949169bb715aa50dbd48a1c",
  "hex",
);
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DurableWorkSessionStore", () => {
  it("lists every same-owner conversation without tokens, expiry defaults, or read side effects", async () => {
    let now = 1_000;
    const fixture = await createFixture({ nowUnixMs: () => now });
    const store = await DurableWorkSessionStore.open(fixture.options);
    await expect(store.listOwnedWorkSessionBindings(OWNER_A)).resolves.toEqual([]);
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "listed-first",
      requestMeta: openAiSession("listed-conversation-first"),
    });
    const second = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "listed-second",
      requestMeta: openAiSession("listed-conversation-second"),
    });
    const other = await store.bind({
      authorizationBinding: OWNER_B,
      transportSessionId: "listed-other-owner",
      requestMeta: openAiSession("listed-conversation-first"),
    });
    now += 400 * 24 * 60 * 60_000;
    const before = await persistedText(fixture);
    const expected = [first.workSessionBinding, second.workSessionBinding];
    await expect(store.listOwnedWorkSessionBindings(OWNER_A)).resolves.toEqual(expected);
    await expect(store.listOwnedWorkSessionBindings(OWNER_B)).resolves.toEqual([
      other.workSessionBinding,
    ]);
    expect(await persistedText(fixture)).toBe(before);
    const reopened = await DurableWorkSessionStore.open(fixture.options);
    await expect(reopened.listOwnedWorkSessionBindings(OWNER_A)).resolves.toEqual(expected);

    const moduleUrl = pathToFileURL(
      resolve("src/infrastructure/mcp/durable-work-session-store.ts"),
    ).href;
    const program = `
      const { DurableWorkSessionStore } = await import(${JSON.stringify(moduleUrl)});
      const store = await DurableWorkSessionStore.open({
        snapshotPath: ${JSON.stringify(fixture.snapshotPath)},
        journalPath: ${JSON.stringify(fixture.journalPath)},
        hmacKey: Buffer.from(${JSON.stringify(HMAC_KEY.toString("hex"))}, "hex"),
        nowUnixMs: () => ${now}
      });
      process.stdout.write(JSON.stringify(await store.listOwnedWorkSessionBindings(${JSON.stringify(OWNER_A)})));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", program],
      { cwd: resolve("."), encoding: "utf8", windowsHide: true },
    );
    expect(JSON.parse(stdout)).toEqual(expected);
    expect(await persistedText(fixture)).toBe(before);
  });

  it("excludes optional TTL expiry at its boundary without pruning or extending sessions", async () => {
    let now = 1_000;
    const fixture = await createFixture({ sessionTtlMs: 50, nowUnixMs: () => now });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "list-expiring-first",
    });
    now = 1_025;
    const second = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "list-expiring-second",
    });
    const before = await persistedText(fixture);
    now = 1_050;
    await expect(store.listOwnedWorkSessionBindings(OWNER_A)).resolves.toEqual([
      second.workSessionBinding,
    ]);
    now = 1_075;
    await expect(store.listOwnedWorkSessionBindings(OWNER_A)).resolves.toEqual([]);
    expect(await persistedText(fixture)).toBe(before);
    now = 1_049;
    await expect(store.listOwnedWorkSessionBindings(OWNER_A)).resolves.toEqual([
      first.workSessionBinding,
      second.workSessionBinding,
    ]);
  });

  it("serializes owner listing after an already queued bind", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const binding = store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "list-queued-bind",
    });
    const listing = store.listOwnedWorkSessionBindings(OWNER_A);
    await expect(listing).resolves.toEqual([(await binding).workSessionBinding]);
  });

  it("keeps one owner and related task stable across MCP transport reconnects", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const taskId = "chatgpt-conversation-8d64fbe9";
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-first",
      requestMeta: relatedTask(taskId),
    });
    const reconnected = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-after-reconnect",
      requestMeta: relatedTask(taskId),
    });

    expect(first).toMatchObject({ source: "related_task", created: true });
    expect(reconnected).toMatchObject({ source: "related_task", created: false });
    expect(reconnected.workSessionBinding).toBe(first.workSessionBinding);
    expect(reconnected.continuationToken).toBe(first.continuationToken);
    expect(reconnected.directGoalClaimantBinding).toBe(first.workSessionBinding);
    expect(reconnected.directJobOwnerBinding).toBe(first.workSessionBinding);

    const persisted = await persistedText(fixture);
    expect(persisted).not.toContain(taskId);
    expect(persisted).not.toContain(OWNER_A);
    expect(persisted).not.toContain("transport-first");
    expect(persisted).not.toContain(first.continuationToken);
  });

  it("keeps one ChatGPT openai/session stable across turns and never persists it raw", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const sessionId = "anonymous-chat-session-8d64fbe9";
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "turn-one-trace",
      requestMeta: openAiSession(sessionId),
    });
    const laterTurn = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "turn-two-trace",
      requestMeta: openAiSession(sessionId),
    });

    expect(first).toMatchObject({ source: "openai_session", created: true });
    expect(laterTurn).toMatchObject({ source: "openai_session", created: false });
    expect(laterTurn.workSessionBinding).toBe(first.workSessionBinding);
    expect(laterTurn.continuationToken).toBe(first.continuationToken);
    expect(await persistedText(fixture)).not.toContain(sessionId);
  });

  it("never merges distinct ChatGPT openai/session values for one authenticated owner", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "chat-a-turn",
      requestMeta: openAiSession("anonymous-chat-session-a"),
    });
    const second = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "chat-b-turn",
      requestMeta: openAiSession("anonymous-chat-session-b"),
    });

    expect(second.workSessionBinding).not.toBe(first.workSessionBinding);
  });

  it("never merges distinct conversations merely because their owner is equal", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const firstTask = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-task-a",
      requestMeta: relatedTask("task-a"),
    });
    const secondTask = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-task-b",
      requestMeta: relatedTask("task-b"),
    });
    const firstFallback = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-fallback-a",
    });
    const secondFallback = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-fallback-b",
    });

    expect(secondTask.workSessionBinding).not.toBe(firstTask.workSessionBinding);
    expect(secondFallback.workSessionBinding).not.toBe(firstFallback.workSessionBinding);
  });

  it("isolates equal related-task values by owner and rejects stolen continuations", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const ownerA = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "owner-a-transport",
      requestMeta: relatedTask("shared-upstream-task-id"),
    });
    const ownerB = await store.bind({
      authorizationBinding: OWNER_B,
      transportSessionId: "owner-b-transport",
      requestMeta: relatedTask("shared-upstream-task-id"),
    });
    expect(ownerB.workSessionBinding).not.toBe(ownerA.workSessionBinding);

    await expect(
      store.bind({
        authorizationBinding: OWNER_B,
        transportSessionId: "stolen-token-transport",
        continuationToken: ownerA.continuationToken,
      }),
    ).rejects.toMatchObject({
      name: "WorkSessionAuthorizationError",
      code: "WORK_SESSION_OWNER_MISMATCH",
    });
    await expect(
      store.resume({
        authorizationBinding: OWNER_B,
        workSessionBinding: ownerA.workSessionBinding,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_OWNER_MISMATCH" });
  });

  it("resumes without related-task metadata through a server-issued opaque token", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const issued = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "fallback-first-transport",
    });
    const resumed = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "fallback-reconnected-transport",
      requestMeta: { "omnicodex/continuation-token": issued.continuationToken },
    });

    expect(issued).toMatchObject({ source: "issued", created: true });
    expect(issued.continuationToken).toMatch(/^wct1_[A-Za-z0-9_-]{43}$/);
    expect(resumed).toMatchObject({ source: "continuation_token", created: false });
    expect(resumed.workSessionBinding).toBe(issued.workSessionBinding);
  });

  it("recovers the same work session from durable bytes in a fresh process", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const issued = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "parent-process-transport",
      requestMeta: relatedTask("durable-cross-process-task"),
    });

    const moduleUrl = pathToFileURL(
      resolve("src/infrastructure/mcp/durable-work-session-store.ts"),
    ).href;
    const program = `
      const module = await import(${JSON.stringify(moduleUrl)});
      const store = await module.DurableWorkSessionStore.open({
        snapshotPath: ${JSON.stringify(fixture.snapshotPath)},
        journalPath: ${JSON.stringify(fixture.journalPath)},
        hmacKey: Buffer.from(${JSON.stringify(HMAC_KEY.toString("hex"))}, "hex")
      });
      const result = await store.bind({
        authorizationBinding: ${JSON.stringify(OWNER_A)},
        transportSessionId: "fresh-process-transport",
        continuationToken: ${JSON.stringify(issued.continuationToken)}
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", program],
      { cwd: resolve("."), encoding: "utf8", windowsHide: true },
    );
    const recovered = JSON.parse(stdout) as { workSessionBinding: string; source: string };
    expect(recovered).toEqual(
      expect.objectContaining({
        workSessionBinding: issued.workSessionBinding,
        source: "continuation_token",
      }),
    );
  });

  it("keeps default sessions durable across the former TTL horizon and a fresh process", async () => {
    let now = 1_000;
    const fixture = await createFixture({ nowUnixMs: () => now });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const issued = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "no-default-expiry-parent",
      requestMeta: relatedTask("no-default-expiry-task"),
    });
    expect(issued.expiresAtUnixMs).toBeUndefined();
    now += 400 * 24 * 60 * 60_000;

    const sameProcess = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "no-default-expiry-late",
      continuationToken: issued.continuationToken,
    });
    expect(sameProcess.workSessionBinding).toBe(issued.workSessionBinding);
    expect(sameProcess.expiresAtUnixMs).toBeUndefined();

    const recovered = await bindInFreshProcess(fixture, {
      authorizationBinding: OWNER_A,
      transportSessionId: "no-default-expiry-after-restart",
      continuationToken: issued.continuationToken,
      nowUnixMs: now,
    });
    expect(recovered).toMatchObject({
      workSessionBinding: issued.workSessionBinding,
      source: "continuation_token",
    });
    expect(recovered).not.toHaveProperty("expiresAtUnixMs");
  });

  it("retains every transport binding by default instead of silently dropping old reconnects", async () => {
    let now = 10_000;
    const fixture = await createFixture({ nowUnixMs: () => now });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-retained-0",
      requestMeta: relatedTask("many-reconnects-task"),
    });
    for (let index = 1; index <= 24; index += 1) {
      now += 1;
      const rebound = await store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId: `transport-retained-${index}`,
        requestMeta: relatedTask("many-reconnects-task"),
      });
      expect(rebound.workSessionBinding).toBe(first.workSessionBinding);
    }

    now += 1;
    const oldestTransport = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-retained-0",
    });
    expect(oldestTransport).toMatchObject({
      workSessionBinding: first.workSessionBinding,
      source: "transport_session",
      created: false,
    });
  });

  it("does not impose the former persistence byte ceiling when no policy was supplied", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const issued = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "large-persistence-parent",
    });
    const journal = await readFile(fixture.journalPath, "utf8");
    await writeFile(
      fixture.journalPath,
      `${journal.trimEnd()}${" ".repeat(17 * 1024 * 1024)}\n`,
      "utf8",
    );

    const recovered = await bindInFreshProcess(fixture, {
      authorizationBinding: OWNER_A,
      transportSessionId: "large-persistence-after-restart",
      continuationToken: issued.continuationToken,
    });
    expect(recovered.workSessionBinding).toBe(issued.workSessionBinding);
  });

  it("accepts explicit retention and maintenance policies beyond the old internal ceilings", async () => {
    const fixture = await createFixture({
      sessionTtlMs: 365 * 24 * 60 * 60_000,
      tombstoneTtlMs: 365 * 24 * 60 * 60_000,
      maxSessions: 100_001,
      maxTombstones: 200_001,
      maxTransportBindings: 129,
      maxJournalEntries: 4_097,
      maxPersistenceBytes: 65 * 1024 * 1024,
    });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const issued = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "large-explicit-policy",
    });
    expect(issued.expiresAtUnixMs).toBeGreaterThan(Date.now());
  });

  it("does not truncate or reject opaque owner, conversation, and transport identities", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const longOwner = [
      "https://issuer.example",
      `subject-${"s".repeat(5_000)}`,
      "client",
      "https://resource.example/mcp",
    ].join("\0");
    const taskId = `conversation-${"t".repeat(5_000)}`;
    const first = await store.bind({
      authorizationBinding: longOwner,
      transportSessionId: `transport-${"a".repeat(5_000)}`,
      requestMeta: relatedTask(taskId),
    });
    const reconnected = await store.bind({
      authorizationBinding: longOwner,
      transportSessionId: `transport-${"b".repeat(5_000)}`,
      requestMeta: relatedTask(taskId),
    });

    expect(reconnected).toMatchObject({
      workSessionBinding: first.workSessionBinding,
      continuationToken: first.continuationToken,
      source: "related_task",
      created: false,
    });
    const persisted = await persistedText(fixture);
    expect(persisted).not.toContain(taskId);
    expect(persisted).not.toContain(longOwner);
  });

  it("multiplexes related tasks on one transport while rejecting conflicting continuations", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const taskA = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-a",
      requestMeta: relatedTask("task-a"),
    });
    const taskB = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "transport-b",
      requestMeta: relatedTask("task-b"),
    });

    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId: "transport-a",
        requestMeta: relatedTask("task-b"),
      }),
    ).resolves.toMatchObject({ workSessionBinding: taskB.workSessionBinding });
    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId: "transport-new",
        requestMeta: relatedTask("task-a"),
        continuationToken: taskB.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_BINDING_CONFLICT" });
    expect(taskB.workSessionBinding).not.toBe(taskA.workSessionBinding);
  });

  it("isolates conversations sharing a transport and requires explicit identity after multiplexing", async () => {
    const fixture = await createFixture({ maxJournalEntries: 2 });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const transportSessionId = "shared-conversation-transport";
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId,
      requestMeta: openAiSession("conversation-a"),
    });
    const second = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId,
      requestMeta: openAiSession("conversation-b"),
    });
    expect(second.workSessionBinding).not.toBe(first.workSessionBinding);
    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId,
        requestMeta: openAiSession("conversation-a"),
      }),
    ).resolves.toMatchObject({ workSessionBinding: first.workSessionBinding, created: false });
    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_BINDING_CONFLICT" });
    await expect(
      store.bind({
        authorizationBinding: OWNER_B,
        transportSessionId,
        requestMeta: openAiSession("conversation-a"),
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_OWNER_MISMATCH" });
    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId,
        requestMeta: openAiSession("conversation-a"),
        continuationToken: second.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_BINDING_CONFLICT" });
    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId,
        requestMeta: openAiSession("conversation-c"),
        continuationToken: first.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_BINDING_CONFLICT" });
    await expect(
      bindInFreshProcess(fixture, {
        authorizationBinding: OWNER_A,
        transportSessionId,
        continuationToken: first.continuationToken,
      }),
    ).resolves.toMatchObject({ workSessionBinding: first.workSessionBinding });
  });

  it("adopts an unscoped transport once before separating subsequent conversations", async () => {
    const fixture = await createFixture();
    const store = await DurableWorkSessionStore.open(fixture.options);
    const input = { authorizationBinding: OWNER_A, transportSessionId: "initial-unscoped" };
    const unscoped = await store.bind(input);
    await expect(
      store.bind({ ...input, requestMeta: openAiSession("first-conversation") }),
    ).resolves.toMatchObject({ workSessionBinding: unscoped.workSessionBinding, created: false });
    const second = await store.bind({ ...input, requestMeta: openAiSession("next-conversation") });
    expect(second.workSessionBinding).not.toBe(unscoped.workSessionBinding);
  });

  it("fails closed when the durable snapshot is corrupted", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.snapshotPath,
      '{"schemaVersion":1,"revision":2,"sessions":[],"tombstones":[],"checksum":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\n',
      "utf8",
    );

    await expect(DurableWorkSessionStore.open(fixture.options)).rejects.toMatchObject({
      name: "WorkSessionPersistenceError",
      code: "WORK_SESSION_PERSISTENCE_INVALID",
    });
  });

  it("bounds the append journal, compacts atomically, and resumes from an old cursor", async () => {
    const fixture = await createFixture({ maxJournalEntries: 2 });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const first = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "compact-transport-1",
      requestMeta: relatedTask("compact-task"),
    });
    const second = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "compact-transport-2",
      requestMeta: relatedTask("compact-task"),
    });

    expect(second.workSessionBinding).toBe(first.workSessionBinding);
    expect(JSON.parse(await readFile(fixture.snapshotPath, "utf8"))).toMatchObject({ revision: 2 });
    expect(await readFile(fixture.journalPath, "utf8")).toBe("");

    const third = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "compact-transport-3",
      continuationToken: first.continuationToken,
    });
    const resume = await store.resume({
      authorizationBinding: OWNER_A,
      workSessionBinding: first.workSessionBinding,
      afterJournalCursor: first.journalCursor,
    });
    expect(third.workSessionBinding).toBe(first.workSessionBinding);
    expect(resume).toMatchObject({ changedSinceCursor: true, cursorWasCompacted: true });
    expect(resume.journalCursor).toBe(third.journalCursor);
    expect((await readFile(fixture.journalPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("expires sessions into owner-bound tombstones instead of reviving old tokens", async () => {
    let now = 1_000;
    const fixture = await createFixture({
      sessionTtlMs: 50,
      tombstoneTtlMs: 500,
      nowUnixMs: () => now,
    });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const issued = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "expiring-transport",
    });
    now = 1_051;

    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId: "after-expiry-transport",
        continuationToken: issued.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_EXPIRED" });
    await expect(
      store.bind({
        authorizationBinding: OWNER_B,
        transportSessionId: "stolen-expired-transport",
        continuationToken: issued.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_OWNER_MISMATCH" });
    expect(await persistedText(fixture)).toContain('"tombstoneUpserts"');
  });

  it("retains expiry tombstones indefinitely unless a tombstone TTL is explicit", async () => {
    let now = 2_000;
    const fixture = await createFixture({ sessionTtlMs: 10, nowUnixMs: () => now });
    const store = await DurableWorkSessionStore.open(fixture.options);
    const issued = await store.bind({
      authorizationBinding: OWNER_A,
      transportSessionId: "indefinite-tombstone-parent",
    });
    now = 2_011;
    await expect(
      store.bind({
        authorizationBinding: OWNER_A,
        transportSessionId: "indefinite-tombstone-expire",
        continuationToken: issued.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_EXPIRED" });

    now += 400 * 24 * 60 * 60_000;
    await expect(
      store.bind({
        authorizationBinding: OWNER_B,
        transportSessionId: "indefinite-tombstone-other-owner",
        continuationToken: issued.continuationToken,
      }),
    ).rejects.toMatchObject({ code: "WORK_SESSION_OWNER_MISMATCH" });
  });
});

interface Fixture {
  readonly directory: string;
  readonly snapshotPath: string;
  readonly journalPath: string;
  readonly options: DurableWorkSessionStoreOptions;
}

async function createFixture(overrides: DurableWorkSessionStoreOptions = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-work-session-"));
  temporaryDirectories.push(directory);
  const snapshotPath = overrides.snapshotPath ?? join(directory, "work-sessions.json");
  const journalPath = overrides.journalPath ?? `${snapshotPath}.journal`;
  return {
    directory,
    snapshotPath,
    journalPath,
    options: {
      dataDirectory: directory,
      snapshotPath,
      journalPath,
      hmacKey: HMAC_KEY,
      ...overrides,
    },
  };
}

function relatedTask(taskId: string): Readonly<Record<string, unknown>> {
  return { "io.modelcontextprotocol/related-task": { taskId } };
}

function openAiSession(sessionId: string): Readonly<Record<string, unknown>> {
  return { "openai/session": sessionId };
}

async function persistedText(fixture: Fixture): Promise<string> {
  const values = await Promise.all(
    [fixture.snapshotPath, fixture.journalPath].map(async (path) =>
      readFile(path, "utf8").catch(() => ""),
    ),
  );
  return values.join("\n");
}

async function bindInFreshProcess(
  fixture: Fixture,
  input: {
    readonly authorizationBinding: string;
    readonly transportSessionId: string;
    readonly continuationToken: string;
    readonly nowUnixMs?: number;
  },
): Promise<Record<string, unknown>> {
  const moduleUrl = pathToFileURL(
    resolve("src/infrastructure/mcp/durable-work-session-store.ts"),
  ).href;
  const program = `
    const module = await import(${JSON.stringify(moduleUrl)});
    const store = await module.DurableWorkSessionStore.open({
      snapshotPath: ${JSON.stringify(fixture.snapshotPath)},
      journalPath: ${JSON.stringify(fixture.journalPath)},
      hmacKey: Buffer.from(${JSON.stringify(HMAC_KEY.toString("hex"))}, "hex"),
      ${input.nowUnixMs === undefined ? "" : `nowUnixMs: () => ${input.nowUnixMs},`}
    });
    const result = await store.bind(${JSON.stringify({
      authorizationBinding: input.authorizationBinding,
      transportSessionId: input.transportSessionId,
      continuationToken: input.continuationToken,
    })});
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", program],
    { cwd: resolve("."), encoding: "utf8", windowsHide: true },
  );
  return JSON.parse(stdout) as Record<string, unknown>;
}
