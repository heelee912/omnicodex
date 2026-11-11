import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableNativeOperationConflictError,
  DurableNativeResourceBusyError,
  DurableNativeResourceLeaseCoordinator,
  DurableNativeResourceOutcomeUnknownError,
  type DurableNativeResourceProcessIdentityReader,
  DurableNativeResourceSnapshotError,
} from "../src/infrastructure/runtime/durable-native-resource-lease-coordinator.js";
import type { RecoveredWindowsProcessIdentity } from "../src/infrastructure/windows/hidden-child-process.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DurableNativeResourceLeaseCoordinator", () => {
  it("recovers a stale bootstrap mutex containing an orphaned atomic-write temp file", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([processIdentity(4091)]);
    const lockPath = `${snapshotPath(directory)}.lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json.53504.crashed.tmp"),
      JSON.stringify({ interruptedBeforeAtomicRename: true }),
      "utf8",
    );
    let now = Date.now() + 5_000;

    const coordinator = await openCoordinator(directory, 4091, identities, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      mutexBootstrapGraceMs: 100,
      acquireTimeoutMs: 50,
      retryDelayMs: 5,
    });
    const acquired = await coordinator.acquire(request("after-bootstrap-crash", "resource-a"));
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind === "acquired") await acquired.lease.abandonBeforeDispatch();
  });

  it("persists only digests and queues another process until authoritative settlement", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([
      processIdentity(4101),
      processIdentity(4102),
    ]);
    const first = await openCoordinator(directory, 4101, identities);
    const second = await openCoordinator(directory, 4102, identities, { retryDelayMs: 2 });
    const canonicalFileKey = "3:file:c:\\secret\\project.godot";
    const acquired = await first.acquire(request("operation-first", canonicalFileKey));
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    await acquired.lease.markDispatched();

    let secondAcquired = false;
    const waiting = second.acquire(request("operation-second", canonicalFileKey)).then((value) => {
      secondAcquired = true;
      return value;
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    expect(secondAcquired).toBe(false);
    expect(await readFile(snapshotPath(directory), "utf8")).not.toContain("project.godot");

    await acquired.lease.settle();
    const next = await waiting;
    expect(next.kind).toBe("acquired");
    if (next.kind === "acquired") await next.lease.abandonBeforeDispatch();
  });

  it("waits for resource settlement without inventing a default acquisition deadline", async () => {
    const directory = await temporaryDirectory();
    let now = 1_000;
    let waits = 0;
    const identities = new FakeProcessIdentityReader([
      processIdentity(4111),
      processIdentity(4112),
    ]);
    const sharedOptions = {
      dataDirectory: directory,
      processIdentityReader: identities,
      now: () => now,
      heartbeatIntervalMs: 1_000_000,
      leaseDurationMs: 3_000_000,
      retryDelayMs: 10_000,
    } as const;
    const first = await DurableNativeResourceLeaseCoordinator.open({
      ...sharedOptions,
      daemon: {
        pid: 4111,
        instanceNonce: "instance-411100000000000000000000",
        startedAtUnixMs: 4_111_000,
      },
    });
    const held = await first.acquire(request("long-holder", "resource-long-wait"));
    if (held.kind !== "acquired") throw new Error("expected first acquisition");
    await held.lease.markDispatched();

    const second = await DurableNativeResourceLeaseCoordinator.open({
      ...sharedOptions,
      daemon: {
        pid: 4112,
        instanceNonce: "instance-411200000000000000000000",
        startedAtUnixMs: 4_112_000,
      },
      sleep: async (milliseconds) => {
        now += milliseconds;
        waits += 1;
        if (waits === 7) await held.lease.settle();
      },
    });
    const acquired = await second.acquire(request("after-long-wait", "resource-long-wait"));
    expect(waits).toBe(7);
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind === "acquired") await acquired.lease.abandonBeforeDispatch();
  });

  it("joins the same live operation and rejects rebinding its operationId", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([processIdentity(4201)]);
    const coordinator = await openCoordinator(directory, 4201, identities);
    const acquired = await coordinator.acquire(request("shared-operation", "resource-a"));
    expect(acquired.kind).toBe("acquired");
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");

    const joined = await coordinator.acquire(request("shared-operation", "resource-a"));
    expect(joined.kind).toBe("join");
    await expect(
      coordinator.acquire({
        ...request("shared-operation", "resource-b"),
        fingerprint: "different-fingerprint",
      }),
    ).rejects.toBeInstanceOf(DurableNativeOperationConflictError);

    await acquired.lease.markDispatched();
    await acquired.lease.settle();
    if (joined.kind === "join") await expect(joined.completion).resolves.toBe("settled");
    const completed = await coordinator.acquire(request("shared-operation", "resource-a"));
    expect(completed).toEqual({ kind: "settled", operationId: "shared-operation" });
  });

  it("recovers an expired prepared lease from a dead exact owner without dispatching twice", async () => {
    const directory = await temporaryDirectory();
    let now = 10_000;
    const identities = new FakeProcessIdentityReader([
      processIdentity(4301),
      processIdentity(4302),
    ]);
    const first = await openCoordinator(directory, 4301, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    const prepared = await first.acquire(request("prepared-before-crash", "resource-a"));
    expect(prepared.kind).toBe("acquired");
    identities.remove(4301);
    now += 30_001;

    const second = await openCoordinator(directory, 4302, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    const replacement = await second.acquire(request("replacement", "resource-a"));
    expect(replacement.kind).toBe("acquired");
    if (replacement.kind === "acquired") await replacement.lease.abandonBeforeDispatch();
  });

  it("inspects one expired owner once while recovering many leases after restart", async () => {
    const directory = await temporaryDirectory();
    let now = 15_000;
    const identities = new FakeProcessIdentityReader([
      processIdentity(4351),
      processIdentity(4352),
    ]);
    const first = await openCoordinator(directory, 4351, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    for (let index = 0; index < 12; index += 1) {
      const acquired = await first.acquire(
        request(`prepared-before-crash-${String(index)}`, `resource-${String(index)}`),
      );
      expect(acquired.kind).toBe("acquired");
    }
    identities.remove(4351);
    now += 30_001;
    const inspectionsBeforeRecovery = identities.inspectionCount(4351);

    await openCoordinator(directory, 4352, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });

    expect(identities.inspectionCount(4351) - inspectionsBeforeRecovery).toBe(1);
  });

  it("fences an expired dispatched lease as unknown until an authoritative recovery probe", async () => {
    const directory = await temporaryDirectory();
    let now = 20_000;
    const identities = new FakeProcessIdentityReader([
      processIdentity(4401),
      processIdentity(4402),
    ]);
    const first = await openCoordinator(directory, 4401, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    const running = await first.acquire(request("crashed-dispatch", "resource-a"));
    if (running.kind !== "acquired") throw new Error("expected acquisition");
    await running.lease.markDispatched();
    identities.remove(4401);
    now += 30_001;

    const second = await openCoordinator(directory, 4402, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
      acquireTimeoutMs: 50,
    });
    await expect(
      second.acquire(request("different-operation", "resource-a")),
    ).rejects.toBeInstanceOf(DurableNativeResourceOutcomeUnknownError);
    await expect(second.recoverUnknown("crashed-dispatch", async () => false)).resolves.toBe(false);
    await expect(second.recoverUnknown("crashed-dispatch", async () => true)).resolves.toBe(true);
    const recovered = await second.acquire(request("different-operation", "resource-a"));
    expect(recovered.kind).toBe("acquired");
    if (recovered.kind === "acquired") await recovered.lease.abandonBeforeDispatch();
  });

  it("reconciles an orphaned unknown operation by its authoritatively verified resource", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([processIdentity(4441)]);
    const coordinator = await openCoordinator(directory, 4441, identities);
    const crashed = await coordinator.acquire(request("lost-operation-id", "1:thread:thread-a"));
    if (crashed.kind !== "acquired") throw new Error("expected acquisition");
    await crashed.lease.markDispatched();
    await coordinator.interruptOwnedOperations("owner_lost");

    await expect(
      coordinator.recoverUnknownResources(["1:thread:thread-a"], async () => false),
    ).resolves.toBe(0);
    await expect(
      coordinator.acquire(request("blocked-before-proof", "1:thread:thread-a")),
    ).rejects.toBeInstanceOf(DurableNativeResourceOutcomeUnknownError);

    await expect(
      coordinator.recoverUnknownResources(["1:thread:thread-a"], async () => true),
    ).resolves.toBe(1);
    const recovered = await coordinator.acquire(
      request("allowed-after-proof", "1:thread:thread-a"),
    );
    expect(recovered.kind).toBe("acquired");
    if (recovered.kind === "acquired") await recovered.lease.abandonBeforeDispatch();
  });

  it("keeps an exact crashed Code Mode operation unknown without bricking the recovered Node REPL lane", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([processIdentity(4451)]);
    const coordinator = await openCoordinator(directory, 4451, identities);
    const crashed = await coordinator.acquire(
      request("crashed-code-mode-operation", "0:lane:node_repl"),
    );
    if (crashed.kind !== "acquired") throw new Error("expected acquisition");
    await crashed.lease.markDispatched();
    await coordinator.interruptOwnedOperations("shutdown_deadline");

    await expect(
      coordinator.acquire(request("crashed-code-mode-operation", "0:lane:node_repl")),
    ).resolves.toEqual({
      kind: "outcome_unknown",
      operationId: "crashed-code-mode-operation",
    });

    const independent = await coordinator.acquire(
      request("independent-code-mode-operation", "0:lane:node_repl"),
    );
    expect(independent.kind).toBe("acquired");
    if (independent.kind === "acquired") await independent.lease.abandonBeforeDispatch();
  });

  it("admits an independent Code Mode operation while recovering an expired owner in the same acquire", async () => {
    const directory = await temporaryDirectory();
    let now = 25_000;
    const identities = new FakeProcessIdentityReader([
      processIdentity(4461),
      processIdentity(4462),
    ]);
    const first = await openCoordinator(directory, 4461, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    const crashed = await first.acquire(
      request("owner-lost-code-mode-operation", "0:lane:node_repl"),
    );
    if (crashed.kind !== "acquired") throw new Error("expected acquisition");
    await crashed.lease.markDispatched();
    const second = await openCoordinator(directory, 4462, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    identities.remove(4461);
    now += 30_001;

    const independent = await second.acquire(
      request("post-recovery-code-mode-operation", "0:lane:node_repl"),
    );
    expect(independent.kind).toBe("acquired");
    if (independent.kind === "acquired") await independent.lease.abandonBeforeDispatch();
    await expect(
      second.acquire(request("owner-lost-code-mode-operation", "0:lane:node_repl")),
    ).resolves.toEqual({
      kind: "outcome_unknown",
      operationId: "owner-lost-code-mode-operation",
    });
  });

  it("continues to serialize a live Code Mode lane across coordinators", async () => {
    const directory = await temporaryDirectory();
    let now = 30_000;
    const identities = new FakeProcessIdentityReader([
      processIdentity(4471),
      processIdentity(4472),
    ]);
    const first = await openCoordinator(directory, 4471, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    const running = await first.acquire(request("live-code-mode", "0:lane:node_repl"));
    if (running.kind !== "acquired") throw new Error("expected acquisition");
    await running.lease.markDispatched();
    now += 30_001;

    const second = await openCoordinator(directory, 4472, identities, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
      acquireTimeoutMs: 25,
      retryDelayMs: 5,
    });
    await expect(
      second.acquire(request("blocked-code-mode", "0:lane:node_repl")),
    ).rejects.toBeInstanceOf(DurableNativeResourceBusyError);
    await running.lease.settle();
  });

  it("keeps a concrete persistent resource fenced when an unknown Code Mode lease names both", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([processIdentity(4481)]);
    const coordinator = await openCoordinator(directory, 4481, identities);
    const resourceKeys = ["0:lane:node_repl", "3:file:c:\\project\\state.json"];
    const crashed = await coordinator.acquire({
      ...request("code-mode-file-mutation", resourceKeys[0] as string),
      resourceKeys,
    });
    if (crashed.kind !== "acquired") throw new Error("expected acquisition");
    await crashed.lease.markDispatched();
    await coordinator.interruptOwnedOperations("shutdown_deadline");

    await expect(
      coordinator.acquire({
        ...request("later-file-mutation", resourceKeys[0] as string),
        resourceKeys,
      }),
    ).rejects.toBeInstanceOf(DurableNativeResourceOutcomeUnknownError);
  });

  it("does not steal an expired lease while the exact PID start identity is still alive", async () => {
    const directory = await temporaryDirectory();
    let now = 30_000;
    const identities = new FakeProcessIdentityReader([
      processIdentity(4501),
      processIdentity(4502),
    ]);
    const first = await openCoordinator(directory, 4501, identities, {
      now: () => now,
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
    });
    const running = await first.acquire(request("live-dispatch", "resource-a"));
    if (running.kind !== "acquired") throw new Error("expected acquisition");
    await running.lease.markDispatched();
    now += 30_001;

    const second = await openCoordinator(directory, 4502, identities, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      heartbeatIntervalMs: 10_000,
      leaseDurationMs: 30_000,
      acquireTimeoutMs: 25,
      retryDelayMs: 5,
    });
    await expect(second.acquire(request("blocked", "resource-a"))).rejects.toBeInstanceOf(
      DurableNativeResourceBusyError,
    );
    await running.lease.settle();
  });

  it("marks dispatched owned operations unknown when bounded shutdown interrupts", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([processIdentity(4601)]);
    const coordinator = await openCoordinator(directory, 4601, identities);
    const running = await coordinator.acquire(request("shutdown-operation", "resource-a"));
    if (running.kind !== "acquired") throw new Error("expected acquisition");
    await running.lease.markDispatched();
    await expect(coordinator.interruptOwnedOperations()).resolves.toBe(1);
    expect((await coordinator.snapshot()).leases).toMatchObject([{ state: "outcome_unknown" }]);
  });

  it("fails closed on a corrupt snapshot instead of erasing ownership state", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([
      processIdentity(4701),
      processIdentity(4702),
    ]);
    const first = await openCoordinator(directory, 4701, identities);
    const acquired = await first.acquire(request("completed", "resource-a"));
    if (acquired.kind !== "acquired") throw new Error("expected acquisition");
    await acquired.lease.abandonBeforeDispatch();
    await writeFile(snapshotPath(directory), '{"schemaVersion":1,"checksum":"bad"}\n', "utf8");
    await expect(openCoordinator(directory, 4702, identities)).rejects.toBeInstanceOf(
      DurableNativeResourceSnapshotError,
    );
  });

  it("does not pretend that Codex Desktop built-ins bypassing OmniCodex share this lease", async () => {
    const directory = await temporaryDirectory();
    const identities = new FakeProcessIdentityReader([processIdentity(4801)]);
    const coordinator = await openCoordinator(directory, 4801, identities);
    // A direct Desktop call has no path through this coordinator. The empty
    // snapshot is deliberate evidence of that product boundary, not coverage.
    expect((await coordinator.snapshot()).leases).toEqual([]);
  });
});

function request(operationId: string, resourceKey: string) {
  return {
    operationId,
    ownerId: "authenticated-owner",
    sessionId: "mcp-session",
    fingerprint: `${operationId}:${resourceKey.toLocaleLowerCase("en-US")}`,
    resourceKeys: [resourceKey.toLocaleLowerCase("en-US")],
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-native-lease-"));
  temporaryDirectories.push(directory);
  return directory;
}

function snapshotPath(directory: string): string {
  return join(directory, "native-resource-leases", "snapshot.json");
}

async function openCoordinator(
  directory: string,
  pid: number,
  processIdentityReader: DurableNativeResourceProcessIdentityReader,
  overrides: Partial<
    Omit<
      Parameters<typeof DurableNativeResourceLeaseCoordinator.open>[0],
      "dataDirectory" | "daemon" | "processIdentityReader"
    >
  > = {},
) {
  return DurableNativeResourceLeaseCoordinator.open({
    dataDirectory: directory,
    daemon: {
      pid,
      instanceNonce: `instance-${String(pid).padEnd(24, "0")}`,
      startedAtUnixMs: pid * 1_000,
    },
    processIdentityReader,
    acquireTimeoutMs: 500,
    retryDelayMs: 5,
    heartbeatIntervalMs: 50,
    leaseDurationMs: 200,
    ...overrides,
  });
}

class FakeProcessIdentityReader implements DurableNativeResourceProcessIdentityReader {
  readonly #identities = new Map<number, RecoveredWindowsProcessIdentity>();
  readonly #inspectionCounts = new Map<number, number>();

  constructor(identities: readonly RecoveredWindowsProcessIdentity[]) {
    for (const identity of identities) this.#identities.set(identity.pid, identity);
  }

  remove(pid: number): void {
    this.#identities.delete(pid);
  }

  inspectionCount(pid: number): number {
    return this.#inspectionCounts.get(pid) ?? 0;
  }

  async inspectWindowsProcess(pid: number): Promise<RecoveredWindowsProcessIdentity | undefined> {
    this.#inspectionCounts.set(pid, (this.#inspectionCounts.get(pid) ?? 0) + 1);
    return this.#identities.get(pid);
  }
}

function processIdentity(pid: number): RecoveredWindowsProcessIdentity {
  return {
    pid,
    parentPid: 1,
    name: "node.exe",
    executablePath: "C:\\Program Files\\nodejs\\node.exe",
    commandLine: `node daemon-${pid}.js`,
    startedAtIso: new Date(pid * 1_000).toISOString(),
  };
}
