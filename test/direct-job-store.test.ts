import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DirectJobAccessInput,
  DirectJobConflictError,
  type DirectJobStartInput,
  DirectJobStore,
} from "../src/infrastructure/mcp/direct-job-store.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DirectJobStore", () => {
  it("binds idempotency to exact work and never persists scope identities or native arguments", async () => {
    const fixture = await durableFixture();
    const store = await DirectJobStore.open({ snapshotPath: fixture.snapshotPath });
    const targetContract = {
      catalogRevision: "a".repeat(64),
      targetIdentity: "app_server\0fs/readFile",
      targetContractDigest: "b".repeat(64),
      modelEffect: "none" as const,
    };
    const input = { ...startInput("idempotency-0001"), targetContract };

    const created = await store.start(input);
    const existing = await store.start(input);
    expect(created.disposition).toBe("created");
    expect(existing).toEqual({ disposition: "existing", job: created.job });
    expect(created.job.operationId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );

    await expect(
      store.start({ ...input, arguments: { path: "C:/other.txt" } }),
    ).rejects.toBeInstanceOf(DirectJobConflictError);

    const snapshot = await readFile(fixture.snapshotPath, "utf8");
    expect(snapshot).not.toContain(input.authorizationBinding);
    expect(snapshot).not.toContain(input.conversationId);
    expect(snapshot).not.toContain(input.workSessionId);
    expect(snapshot).not.toContain(input.idempotencyKey);
    expect(snapshot).not.toContain("C:/workspace/file.txt");
    expect(
      (JSON.parse(snapshot) as { jobs: Array<{ targetContract?: unknown }> }).jobs[0]
        ?.targetContract,
    ).toEqual(targetContract);
  });

  it("looks up an existing exact fingerprint without creating an absent job", async () => {
    const store = DirectJobStore.inMemory();
    const input = startInput("existing-read-only-0001");
    expect(await store.findExisting(input)).toBeUndefined();

    const created = await store.start(input);
    expect(await store.findExisting(input)).toEqual({
      disposition: "existing",
      job: created.job,
    });
    await expect(
      store.findExisting({ ...input, arguments: { path: "C:/different.txt" } }),
    ).rejects.toBeInstanceOf(DirectJobConflictError);
    expect((await store.list({ ...input })).jobs).toHaveLength(1);
  });

  it("persists the terminal native result for same-scope reconnect readback", async () => {
    const store = DirectJobStore.inMemory();
    const input = startInput("idempotency-0002");
    const created = await store.start(input);
    const access = accessInput(input, created.job.jobId);

    expect((await store.markRunning(access)).status).toBe("running");
    const result = {
      content: [{ type: "text" as const, text: "DIRECT_JOB_RESULT_OK" }],
      structuredContent: { ok: true },
    };
    expect((await store.succeed(access, result)).status).toBe("succeeded");
    expect(await store.get(access)).toMatchObject({ status: "succeeded", result });

    expect(await store.get({ ...access, authorizationBinding: "owner-other" })).toBeUndefined();
    expect(await store.get({ ...access, conversationId: "conversation-other" })).toBeUndefined();
    expect(await store.get({ ...access, workSessionId: "work-other" })).toBeUndefined();
  });

  it("persists and reopens the complete JSON-safe error envelope without field loss", async () => {
    const fixture = await durableFixture();
    const store = await DirectJobStore.open({ snapshotPath: fixture.snapshotPath });
    const input = startInput("structured-error-envelope-0001");
    const created = await store.start(input);
    const access = accessInput(input, created.job.jobId);
    await store.markRunning(access);
    const error = {
      code: "NATIVE_RPC_FAILURE",
      message: "Native RPC failed after dispatch",
      details: {
        name: "NativeRpcError",
        code: -32_041,
        data: {
          stdout: ["first", "second", "third"],
          stderr: "complete stderr",
        },
        rpcError: {
          code: -32_041,
          message: "RPC failed",
          data: { requestId: "request-structured", nativePayload: { full: true } },
        },
        retry: { retryable: true, retryAfterMs: 12_345, attempt: 2 },
        cause: {
          name: "TransportError",
          message: "pipe closed",
          data: { phase: "response" },
        },
      },
    };

    await store.markOutcomeUnknown(access, error);
    const reopened = (await readInFreshProcess(fixture.snapshotPath, access)) as {
      error: unknown;
    };
    expect(reopened.error).toEqual(error);
  });

  it("cancels queued work before dispatch and records running cancellation only after acknowledgement", async () => {
    const store = DirectJobStore.inMemory();
    const queuedInput = startInput("idempotency-0003");
    const queued = await store.start(queuedInput);
    const queuedCancel = await store.requestCancel(accessInput(queuedInput, queued.job.jobId));
    expect(queuedCancel).toMatchObject({ disposition: "cancelled", job: { status: "cancelled" } });
    await expect(
      store.markRunning(accessInput(queuedInput, queued.job.jobId)),
    ).rejects.toMatchObject({
      code: "DIRECT_JOB_INVALID_TRANSITION",
    });

    const runningInput = startInput("idempotency-0004");
    const running = await store.start(runningInput);
    const runningAccess = accessInput(runningInput, running.job.jobId);
    await store.markRunning(runningAccess);
    const request = await store.requestCancel(runningAccess);
    expect(request).toMatchObject({
      disposition: "cancellation_requested",
      job: { status: "running" },
    });
    expect((await store.finishCancelled(runningAccess)).status).toBe("cancelled");
  });

  it("atomically fences queued and running work while preserving terminal results", async () => {
    const store = DirectJobStore.inMemory();
    const fenceError = { code: "RUNTIME_DRAIN_TIMEOUT", message: "Native drain deadline elapsed" };

    const queuedInput = startInput("atomic-fence-queued-0001");
    const queued = await store.start(queuedInput);
    const queuedAccess = accessInput(queuedInput, queued.job.jobId);
    expect(await store.fenceTerminal(queuedAccess, fenceError)).toMatchObject({
      status: "cancelled",
      error: fenceError,
    });
    await expect(store.markRunning(queuedAccess)).rejects.toMatchObject({
      code: "DIRECT_JOB_INVALID_TRANSITION",
    });

    const runningInput = startInput("atomic-fence-running-001");
    const running = await store.start(runningInput);
    const runningAccess = accessInput(runningInput, running.job.jobId);
    await store.markRunning(runningAccess);
    expect(await store.fenceTerminal(runningAccess, fenceError)).toMatchObject({
      status: "outcome_unknown",
      error: fenceError,
    });

    const completeInput = startInput("atomic-fence-complete-01");
    const complete = await store.start(completeInput);
    const completeAccess = accessInput(completeInput, complete.job.jobId);
    await store.markRunning(completeAccess);
    const succeeded = await store.succeed(completeAccess, {
      content: [{ type: "text", text: "authoritative" }],
    });
    expect(await store.fenceTerminal(completeAccess, fenceError)).toEqual(succeeded);
  });

  it("uses owner-scoped stable pagination without leaking another work session", async () => {
    let now = 100;
    const store = DirectJobStore.inMemory({ nowUnixMs: () => now++ });
    for (const suffix of ["0010", "0011", "0012"]) {
      await store.start(startInput(`idempotency-${suffix}`));
    }
    await store.start({
      ...startInput("idempotency-0013"),
      workSessionId: "another-work-session",
    });

    const scope = startInput("unused-idempotency");
    const first = await store.list({ ...scope, limit: 2 });
    expect(first.jobs).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf("string");
    if (first.nextCursor === undefined) throw new Error("expected a second page");
    const second = await store.list({ ...scope, limit: 2, cursor: first.nextCursor });
    expect(second.jobs).toHaveLength(1);
    expect(new Set([...first.jobs, ...second.jobs].map((job) => job.jobId)).size).toBe(3);
  });

  it("recovers queued work as safely cancelled and dispatched work as outcome_unknown", async () => {
    const queuedFixture = await durableFixture();
    const queuedStore = await DirectJobStore.open({ snapshotPath: queuedFixture.snapshotPath });
    const queuedInput = startInput("restart-queued-0001");
    const queued = await queuedStore.start(queuedInput);
    const recoveredQueued = await readInFreshProcess(
      queuedFixture.snapshotPath,
      accessInput(queuedInput, queued.job.jobId),
    );
    expect(recoveredQueued).toMatchObject({
      status: "cancelled",
      error: { code: "PROCESS_RESTART_BEFORE_DISPATCH" },
    });
    expect(
      await readInFreshProcess(
        queuedFixture.snapshotPath,
        accessInput(queuedInput, queued.job.jobId),
      ),
    ).toMatchObject({ status: "cancelled" });

    const runningFixture = await durableFixture();
    const runningStore = await DirectJobStore.open({ snapshotPath: runningFixture.snapshotPath });
    const runningInput = startInput("restart-running-001");
    const running = await runningStore.start(runningInput);
    const runningAccess = accessInput(runningInput, running.job.jobId);
    await runningStore.markRunning(runningAccess);
    const recoveredRunning = await readInFreshProcess(runningFixture.snapshotPath, runningAccess);
    expect(recoveredRunning).toMatchObject({
      status: "outcome_unknown",
      error: { code: "PROCESS_RESTART_AFTER_DISPATCH" },
    });
  });

  it("bounds durable result size before committing a false success", async () => {
    const store = DirectJobStore.inMemory({ maxResultBytes: 64 });
    const input = startInput("result-limit-0001");
    const job = await store.start(input);
    const access = accessInput(input, job.job.jobId);
    await store.markRunning(access);
    expect(() =>
      store.succeed(access, { content: [{ type: "text", text: "x".repeat(1_024) }] }),
    ).toThrow(RangeError);
    expect(await store.get(access)).toMatchObject({ status: "running" });
  });

  it("persists and reopens a result larger than the former implicit limit by default", async () => {
    const fixture = await durableFixture();
    const store = await DirectJobStore.open({ snapshotPath: fixture.snapshotPath });
    const input = startInput("lossless-large-result-0001");
    const created = await store.start(input);
    const access = accessInput(input, created.job.jobId);
    await store.markRunning(access);
    const payload = `DIRECT_JOB_LARGE_BEGIN${"x".repeat(16 * 1024 * 1024)}DIRECT_JOB_LARGE_END`;

    await expect(
      store.succeed(access, { content: [{ type: "text", text: payload }] }),
    ).resolves.toMatchObject({ status: "succeeded" });
    const reopened = await readInFreshProcess(fixture.snapshotPath, access);
    expect(reopened).toMatchObject({ status: "succeeded" });
    const text = (reopened as { result: { content: Array<{ text: string }> } }).result.content[0]
      ?.text;
    expect(text).toHaveLength(payload.length);
    expect(text?.startsWith("DIRECT_JOB_LARGE_BEGIN")).toBe(true);
    expect(text?.endsWith("DIRECT_JOB_LARGE_END")).toBe(true);
  });

  it("retains more jobs than the former implicit item cap by default", async () => {
    const store = DirectJobStore.inMemory();
    let first: { readonly input: DirectJobStartInput; readonly jobId: string } | undefined;
    for (let index = 0; index <= 4_096; index += 1) {
      const input = startInput(`lossless-job-${String(index).padStart(5, "0")}`);
      const created = await store.start(input);
      first ??= { input, jobId: created.job.jobId };
    }
    if (first === undefined) throw new Error("Missing first direct job");
    await expect(store.get(accessInput(first.input, first.jobId))).resolves.toMatchObject({
      jobId: first.jobId,
      status: "queued",
    });
    await expect(
      store.list({
        authorizationBinding: first.input.authorizationBinding,
        conversationId: first.input.conversationId,
        workSessionId: first.input.workSessionId,
      }),
    ).resolves.toMatchObject({ jobs: { length: 4_097 } });
  });
});

function startInput(idempotencyKey: string): DirectJobStartInput {
  return {
    authorizationBinding: "owner-binding-secret",
    conversationId: "chatgpt-conversation-1",
    workSessionId: "work-session-1",
    idempotencyKey,
    toolName: "codex__app_server__fs_readFile",
    arguments: { path: "C:/workspace/file.txt" },
  };
}

function accessInput(input: DirectJobStartInput, jobId: string): DirectJobAccessInput {
  return {
    authorizationBinding: input.authorizationBinding,
    conversationId: input.conversationId,
    workSessionId: input.workSessionId,
    jobId,
  };
}

async function durableFixture(): Promise<{ readonly snapshotPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-direct-jobs-"));
  temporaryDirectories.push(directory);
  return { snapshotPath: join(directory, "direct-job-store.json") };
}

async function readInFreshProcess(
  snapshotPath: string,
  access: DirectJobAccessInput,
): Promise<unknown> {
  const moduleUrl = pathToFileURL(resolve("src/infrastructure/mcp/direct-job-store.ts")).href;
  const script = `
    const { DirectJobStore } = await import(${JSON.stringify(moduleUrl)});
    const store = await DirectJobStore.open({ snapshotPath: ${JSON.stringify(snapshotPath)} });
    process.stdout.write(JSON.stringify(await store.get(${JSON.stringify(access)})));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: resolve("."),
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}
