import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LegacyMutationCoordinator } from "../src/infrastructure/mcp/legacy-mutation-coordinator.js";
import { readLegacyMutationStatus } from "../src/infrastructure/mcp/legacy-mutation-status-tool.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const semanticDigest = digest("synthetic-request");
const context = (owner = "owner-a", requestId = 1) => ({
  authorizationBinding: owner,
  semanticDigest,
  sessionId: "synthetic-private-session",
  requestId,
});
async function leader(coordinator: LegacyMutationCoordinator, owner = "owner-a", requestId = 1) {
  const acquisition = await coordinator.acquire(context(owner, requestId));
  if (acquisition.kind !== "execute") throw new Error("expected synthetic leader");
  return acquisition.execution;
}

describe("owner-only legacy mutation status", () => {
  it("projects every stored terminal state without results or transport identities", async () => {
    const coordinator = LegacyMutationCoordinator.inMemory({ maxCompletedResults: 1 });
    const expired = await leader(coordinator);
    await expired.finish({
      secret: "synthetic-result-secret",
      continuationToken: "synthetic-token",
    });
    const completed = await leader(coordinator, "owner-a", 2);
    await completed.finish({ sensitive: "synthetic-result-body" });
    const unknown = await leader(coordinator, "owner-a", 3);
    await unknown.outcomeUnknown("NATIVE_DISPATCH_FAILED");
    const active = await leader(coordinator, "owner-a", 4);
    const page = await coordinator.readStatus({ authorizationBinding: "owner-a", semanticDigest });
    expect(page.matchCount).toBe(4);
    expect(page.matches.map((value) => value.state).sort()).toEqual([
      "completed",
      "in_flight",
      "outcome_unknown",
      "result_replay_expired",
    ]);
    expect(page.matches.find((value) => value.operationId === expired.operationId)).toMatchObject({
      code: "LEGACY_MUTATION_RESULT_REPLAY_EXPIRED",
      completedResultRetained: false,
    });
    expect(page.matches.find((value) => value.operationId === unknown.operationId)).toMatchObject({
      code: "NATIVE_DISPATCH_FAILED",
      completedResultRetained: false,
    });
    expect(page.matches.find((value) => value.operationId === completed.operationId)).toMatchObject(
      {
        completedResultRetained: true,
      },
    );
    const serialized = JSON.stringify(page);
    for (const privateValue of [
      "synthetic-result-secret",
      "synthetic-token",
      "synthetic-result-body",
      "synthetic-private-session",
      "authorizationDigest",
      "semanticDigest",
      "requestDigest",
      "sessionDigest",
      "members",
      "value",
    ])
      expect(serialized).not.toContain(privateValue);
    await active.failBeforeDispatch();
  });

  it("does not reveal whether an operation belongs to a different owner", async () => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    const foreign = await leader(coordinator, "owner-b");
    await foreign.outcomeUnknown();
    const notOwned = await coordinator.readStatus({
      authorizationBinding: "owner-a",
      operationId: foreign.operationId,
    });
    const notFound = await coordinator.readStatus({
      authorizationBinding: "owner-a",
      operationId: "00000000-0000-5000-8000-000000000000",
    });
    expect(notOwned).toEqual(notFound);
    expect(notOwned).toEqual({ matches: [], matchCount: 0, nextCursor: null });
    expect(
      await coordinator.readStatus({ authorizationBinding: "owner-a", semanticDigest }),
    ).toEqual(notFound);
  });

  it("uses AND when an operation and exact semantics are both supplied", async () => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    const execution = await leader(coordinator);
    await execution.outcomeUnknown();
    const query = { authorizationBinding: "owner-a", operationId: execution.operationId };
    expect((await coordinator.readStatus({ ...query, semanticDigest })).matchCount).toBe(1);
    expect(
      (await coordinator.readStatus({ ...query, semanticDigest: digest("different args") }))
        .matchCount,
    ).toBe(0);
  });

  it("paginates all matching owner records without dropping ambiguity or admitting anything", async () => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    for (let requestId = 1; requestId <= 7; requestId++)
      await (await leader(coordinator, "owner-a", requestId)).outcomeUnknown();
    await (await leader(coordinator, "owner-b")).outcomeUnknown();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await coordinator.readStatus({
        authorizationBinding: "owner-a",
        semanticDigest,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.matchCount).toBe(7);
      ids.push(...page.matches.map((value) => value.operationId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(new Set(ids).size).toBe(7);
    await expect(
      coordinator.acquire({ ...context(), sessionId: "other-session" }),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_LEGACY_MUTATION_COHORT" });
  });

  it("never writes durable files, recovers an active attempt or prunes on lookup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owner-status-read-"));
    const coordinator = await LegacyMutationCoordinator.open({
      snapshotPath: join(directory, "state.json"),
    });
    const active = await leader(coordinator);
    await (await leader(coordinator, "owner-a", 2)).outcomeUnknown("NATIVE_DISPATCH_FAILED");
    const files = async (path: string): Promise<Record<string, string>> => {
      const output: Record<string, string> = {};
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          for (const [child, value] of Object.entries(await files(join(path, entry.name))))
            output[`${entry.name}/${child}`] = value;
        } else
          output[entry.name] = digest((await readFile(join(path, entry.name))).toString("base64"));
      }
      return output;
    };
    const before = await files(directory);
    for (let index = 0; index < 4; index++)
      await coordinator.readStatus({ authorizationBinding: "owner-a", semanticDigest });
    expect(await files(directory)).toEqual(before);
    expect(
      (
        await coordinator.readStatus({
          authorizationBinding: "owner-a",
          operationId: active.operationId,
        })
      ).matches[0]?.state,
    ).toBe("in_flight");
    expect((await coordinator.acquire(context())).kind).toBe("join");
    await active.failBeforeDispatch();
  });

  it("does not expose mutable state references", async () => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    const execution = await leader(coordinator);
    await execution.outcomeUnknown("NATIVE_DISPATCH_FAILED");
    const query = { authorizationBinding: "owner-a", operationId: execution.operationId };
    const page = await coordinator.readStatus(query);
    Object.assign(page.matches[0] ?? {}, { state: "completed", code: "FAKE" });
    expect((await coordinator.readStatus(query)).matches[0]).toMatchObject({
      state: "outcome_unknown",
      code: "NATIVE_DISPATCH_FAILED",
    });
  });

  it.each([
    { authorizationBinding: "" },
    { authorizationBinding: "owner-a" },
    { authorizationBinding: "owner-a", operationId: "not-an-id" },
    { authorizationBinding: "owner-a", semanticDigest, limit: 0 },
    { authorizationBinding: "owner-a", semanticDigest, limit: 51 },
    { authorizationBinding: "owner-a", semanticDigest, cursor: "not-a-cursor" },
  ])("rejects invalid owner/selector/continuation %j", (query) => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    expect(() => coordinator.readStatus(query)).toThrow();
  });

  it("returns an operation-only status without fabricating a historical action link", async () => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    const execution = await leader(coordinator);
    await execution.outcomeUnknown("NATIVE_DISPATCH_FAILED");
    const fingerprint = vi.fn(async () => semanticDigest);
    const result = await readLegacyMutationStatus({
      coordinator,
      authorizationBinding: "owner-a",
      arguments: { operationId: execution.operationId },
      fingerprint,
    });
    expect(result.structuredContent).toMatchObject({
      outcome: "matched",
      selectionBasis: "operation_id_only",
      historicalActionLink: "unavailable",
      originalRequestIdentity: "not_retained",
      deliveryEvidence: "not_retained",
      replayPermittedByThisRead: false,
    });
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it("preserves multiple semantic candidates instead of identifying a guessed original request", async () => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    await (await leader(coordinator)).outcomeUnknown();
    await (await leader(coordinator, "owner-a", 2)).outcomeUnknown();
    const result = await readLegacyMutationStatus({
      coordinator,
      authorizationBinding: "owner-a",
      arguments: {
        request: { toolName: "synthetic-tool", arguments: { value: "synthetic" } },
        limit: 1,
      },
      fingerprint: async () => semanticDigest,
    });
    expect(result.structuredContent).toMatchObject({
      outcome: "multiple_semantic_candidates",
      matchCount: 2,
      historicalActionLink: "semantic_candidates_only",
      originalRequestIdentity: "not_retained",
      nativeOutcomeInference: "none",
    });
    expect(result.structuredContent?.nextCursor).toEqual(expect.any(String));
  });

  it.each([
    { ownerBinding: "owner-b" },
    { semanticDigest },
    { request: { toolName: "synthetic-tool", arguments: {}, ownerBinding: "owner-b" } },
    { request: { toolName: "synthetic-tool", arguments: [] } },
  ])("rejects a public owner/digest override or malformed request %j", async (args) => {
    const coordinator = LegacyMutationCoordinator.inMemory();
    await expect(
      readLegacyMutationStatus({
        coordinator,
        authorizationBinding: "owner-a",
        arguments: args,
        fingerprint: async () => semanticDigest,
      }),
    ).rejects.toThrow();
  });
});
