import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

const root = new URL("../", import.meta.url);

function commandBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("CLI lifecycle transition serialization", () => {
  it("keeps legacy Web-task orchestration out of the product CLI and public API", async () => {
    const [cli, index] = await Promise.all([
      readFile(new URL("src/cli.ts", root), "utf8"),
      readFile(new URL("src/index.ts", root), "utf8"),
    ]);
    expect(cli).not.toContain('.command("task-parity")');
    expect(cli).not.toContain("OracleTaskParityService");
    expect(cli).not.toContain('.command("watch")');
    expect(cli).not.toContain("selectBoundOracleSurface");
    expect(cli).not.toContain("HiddenOracleTaskRunner");
    expect(index).not.toContain('export * from "./application/oracle-task-parity.js"');
  });

  it("does not synthesize an authenticated control deadline around caller-selected drain", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    expect(source).not.toContain("RUNTIME_SWITCH_OBSERVATION_MS");
    expect(source).not.toContain("RUNTIME_SWITCH_CONTROL_MARGIN_MS");
    expect(source).not.toContain("drainTimeoutMs + 602_000");
    expect(source).toContain('requestDaemonControl(state, "stop", drainTimeoutMs)');
  });

  it("uses the daemon stop boundary instead of global Web-task idle loops", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const stopHelper = commandBlock(
      source,
      "async function drainAndStopOwnedDaemon(",
      "async function stopStartingOwnedDaemonBeforeLifecycleLock()",
    );

    expect(source).not.toContain("awaitOracleTaskParityIdle");
    expect(stopHelper).not.toContain("awaitActiveOracleWebTurns");
    expect(stopHelper).not.toContain('requestDaemonControl(state, "begin-drain", drainTimeoutMs)');
    expect(stopHelper).not.toContain(
      'requestDaemonControl(state, "await-drained", drainTimeoutMs)',
    );
    expect(stopHelper).toContain('requestDaemonControl(state, "stop", drainTimeoutMs)');
  });

  it("does not cut off daemon shutdown or control-close phases with internal budgets", async () => {
    const [cliSource, daemonSource] = await Promise.all([
      readFile(new URL("src/cli.ts", root), "utf8"),
      readFile(new URL("src/daemon.ts", root), "utf8"),
    ]);
    const cli = cliSource.replaceAll("\r\n", "\n");
    const daemon = daemonSource.replaceAll("\r\n", "\n");

    expect(daemon).not.toContain("DAEMON_GATEWAY_SHUTDOWN_BUDGET_MS");
    expect(daemon).not.toContain("DAEMON_AUXILIARY_SHUTDOWN_BUDGET_MS");
    expect(daemon).not.toContain("DAEMON_FINAL_STATE_BUDGET_MS");
    expect(cli).not.toContain("DAEMON_BOUNDED_SHUTDOWN_BUDGET_MS");
    expect(cli).not.toContain("DAEMON_CONTROL_CLOSE_MARGIN_MS");
    expect(cli.match(/waitForDaemonControlClose\(state\)/g)).toHaveLength(4);
    expect(cli).not.toContain("waitForDaemonControlClose(state, 30_000)");
    expect(cli).not.toContain("within 30 seconds");
  });

  it("lets an autostart watchdog adopt a live transition before lifecycle-lock acquisition", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const block = commandBlock(
      source,
      "async function launchThroughScheduledTaskWhenEnabled()",
      "async function waitForDaemon(",
    );
    const sourceGuard = block.indexOf("if (process.env.OMNICODEX_AUTOSTART_SOURCE !== undefined)");
    const stateRead = block.indexOf(
      "const existing = await readOmniCodexDaemonState();",
      sourceGuard,
    );
    const ownershipProbe = block.indexOf("await daemonOwnershipIsLive(existing)", stateRead);
    const failureGuard = block.indexOf('if (existing.lifecycle === "failed")', ownershipProbe);
    const successfulAdoption = block.indexOf("return existing;", failureGuard);

    expect(sourceGuard).toBeGreaterThanOrEqual(0);
    expect(stateRead).toBeGreaterThan(sourceGuard);
    expect(ownershipProbe).toBeGreaterThan(stateRead);
    expect(failureGuard).toBeGreaterThan(ownershipProbe);
    expect(successfulAdoption).toBeGreaterThan(failureGuard);
    expect(block).not.toContain(
      'process.platform !== "win32" || process.env.OMNICODEX_AUTOSTART_SOURCE !== undefined',
    );
  });

  it("repairs the owned launcher before interactive start verifies scheduled-task status", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const block = commandBlock(
      source,
      "async function launchThroughScheduledTaskWhenEnabled()",
      "async function waitForDaemon(",
    );
    const sourceGuard = block.indexOf("if (process.env.OMNICODEX_AUTOSTART_SOURCE !== undefined)");
    const successfulAdoption = block.indexOf("return existing;", sourceGuard);
    const launcherPreparation = block.indexOf(
      "await ensureStableReleaseLauncher();",
      successfulAdoption,
    );
    const manager = block.indexOf("const manager = autostartManager();", launcherPreparation);
    const status = block.indexOf(
      "const status: WindowsAutostartStatus = await manager.status();",
      manager,
    );

    expect(sourceGuard).toBeGreaterThanOrEqual(0);
    expect(launcherPreparation).toBeGreaterThan(successfulAdoption);
    expect(manager).toBeGreaterThan(launcherPreparation);
    expect(status).toBeGreaterThan(manager);
  });

  it("waits for an independently starting scheduled task instead of reporting a false restart failure", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const block = commandBlock(
      source,
      "async function launchThroughScheduledTaskWhenEnabled()",
      "async function waitForDaemon(",
    );

    expect(block).toContain(
      "await withDaemonLifecycleLock(ensureInternalIntegrityKeysInitialized, {\n    waitOnContention: true,\n  });",
    );
  });

  it("adopts an owned daemon that started during bootstrap before the launch polling timestamp", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const launch = commandBlock(
      source,
      "async function launchThroughScheduledTaskWhenEnabled()",
      "async function waitForDaemon(",
    );
    const polling = launch.slice(launch.indexOf("while (Date.now() <= deadline)"));
    const decision = commandBlock(
      polling,
      "    const state = await readOmniCodexDaemonState();",
      "    const settledLaunch = await manager.lastLaunch();",
    );
    const poll = new Function(
      "readOmniCodexDaemonState",
      "daemonOwnershipIsLive",
      "invokedAt",
      `return (async () => { ${decision} })();`,
    );
    const state = { pid: 38844, startedAtUnixMs: 1_000, lifecycle: "ready" };
    const readState = vi.fn().mockResolvedValue(state);
    const ownershipIsLive = vi.fn().mockResolvedValue(true);

    expect(await poll(readState, ownershipIsLive, 2_000)).toBe(state);
    expect(ownershipIsLive).toHaveBeenCalledWith(state);
    ownershipIsLive.mockResolvedValue(false);
    expect(await poll(readState, ownershipIsLive, 2_000)).toBeUndefined();

    readState.mockResolvedValue({ ...state, lifecycle: "starting" });
    expect(await poll(readState, ownershipIsLive, 2_000)).toBeUndefined();
    readState.mockResolvedValue({ ...state, lifecycle: "failed", error: "prior launch failed" });
    expect(await poll(readState, ownershipIsLive, 2_000)).toBeUndefined();
    readState.mockResolvedValue({
      ...state,
      startedAtUnixMs: 3_000,
      lifecycle: "failed",
      error: "current launch failed",
    });
    await expect(poll(readState, ownershipIsLive, 2_000)).rejects.toThrow("current launch failed");
  });

  it("keeps polling through the start deadline and settles a failed scheduled launch from its receipt", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const block = commandBlock(
      source,
      "async function launchThroughScheduledTaskWhenEnabled()",
      "async function waitForDaemon(",
    );
    const baseline = block.indexOf("let observedLaunch = await manager.lastLaunch();");
    const deadline = block.indexOf("const deadline = invokedAt + 180_000;", baseline);
    const polling = block.indexOf("while (Date.now() <= deadline)", deadline);
    const settlement = block.indexOf("const settledLaunch = await manager.lastLaunch();", polling);
    const instanceProbe = block.indexOf("await manager.runningInstanceCount()", settlement);
    const launch = block.indexOf("await manager.launch();", instanceProbe);
    const timeout = block.indexOf(
      "Timed out waiting for scheduled OmniCodex daemon state or launch receipt",
      launch,
    );
    const currentLaunch = block.indexOf(
      "Date.parse(settledLaunch.startedAt) >= invokedAt",
      settlement,
    );
    const failure = block.indexOf('settledLaunch.event === "autostart_failed"', settlement);

    expect(baseline).toBeGreaterThanOrEqual(0);
    expect(deadline).toBeGreaterThan(baseline);
    expect(polling).toBeGreaterThan(deadline);
    expect(settlement).toBeGreaterThan(polling);
    expect(instanceProbe).toBeGreaterThan(settlement);
    expect(launch).toBeGreaterThan(instanceProbe);
    expect(timeout).toBeGreaterThan(launch);
    expect(block).toContain(
      "if (!launchRequested && (await manager.runningInstanceCount()) === 0)",
    );
    expect(block).toContain("!sameAutostartLaunchReceipt(observedLaunch, settledLaunch)");
    expect(block).toContain("Date.parse(settledLaunch.startedAt) < invokedAt");
    expect(block).toContain("launchRequested = false;");
    expect(block).toContain("observedLaunch = settledLaunch;");
    expect(block.match(/await manager\.launch\(\);/gu)).toHaveLength(1);
    expect(currentLaunch).toBeGreaterThan(settlement);
    expect(failure).toBeGreaterThan(currentLaunch);
    expect(failure).toBeGreaterThan(settlement);
    expect(block).not.toContain("SCHEDULED_TASK_START_TIMEOUT");
  });

  it("does not spawn another instance query after launch was acknowledged", async () => {
    const source = await readFile(new URL("src/cli.ts", root), "utf8");
    const decision = commandBlock(
      source,
      "    if (!launchRequested && (await manager.runningInstanceCount()) === 0)",
      "    await delay(250);",
    );
    const poll = new Function(
      "manager",
      "launchRequested",
      `return (async () => { ${decision} return launchRequested; })();`,
    );
    const manager = {
      runningInstanceCount: vi.fn().mockResolvedValue(0),
      launch: vi.fn().mockResolvedValue(undefined),
    };
    expect(await poll(manager, true)).toBe(true);
    expect(manager.runningInstanceCount).not.toHaveBeenCalled();
    expect(manager.launch).not.toHaveBeenCalled();

    expect(await poll(manager, false)).toBe(true);
    expect(manager.runningInstanceCount).toHaveBeenCalledTimes(1);
    expect(manager.launch).toHaveBeenCalledTimes(1);

    manager.runningInstanceCount.mockResolvedValue(1);
    expect(await poll(manager, false)).toBe(false);
    expect(manager.runningInstanceCount).toHaveBeenCalledTimes(2);
    expect(manager.launch).toHaveBeenCalledTimes(1);
  });

  it("keeps the scheduled action alive for the exact daemon without holding the lifecycle lock", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const startBlock = commandBlock(
      source,
      'program\n  .command("start")',
      'program\n  .command("stop")',
    );
    const lifecycleLock = startBlock.indexOf("const ready = await withDaemonLifecycleLock(");
    const lockClosure = startBlock.indexOf("    });", lifecycleLock);
    const supervision = startBlock.indexOf(
      "await superviseScheduledTaskDaemon(ready);",
      lockClosure,
    );
    expect(lifecycleLock).toBeGreaterThanOrEqual(0);
    expect(lockClosure).toBeGreaterThan(lifecycleLock);
    expect(supervision).toBeGreaterThan(lockClosure);

    const helper = commandBlock(
      source,
      "async function superviseScheduledTaskDaemon(",
      "interface DaemonControlResponse",
    );
    expect(helper).toContain('process.env.OMNICODEX_AUTOSTART_SOURCE !== "scheduled-task"');
    expect(helper).toContain("await waitForExactDaemonProcessExit(state);");
    expect(helper).toContain('entry.event === "daemon_stopped"');
    expect(helper).toContain('entry.event === "daemon_failed"');
    expect(helper).toContain(
      "Scheduled OmniCodex daemon exited without a terminal lifecycle receipt",
    );
    expect(helper).not.toContain("withDaemonLifecycleLock");
    expect(helper).not.toContain("setTimeout");
  });

  it("preserves hidden daemon stderr and records fatal runtime failures", async () => {
    const cli = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const daemon = (await readFile(new URL("src/daemon.ts", root), "utf8")).replaceAll(
      "\r\n",
      "\n",
    );
    expect(cli).toContain('join(daemonLogDirectory, "daemon-stderr.log")');
    expect(cli).toContain('stdio: ["ignore", "ignore", daemonStderr]');
    expect(daemon).toContain('process.on("uncaughtException"');
    expect(daemon).toContain('process.on("unhandledRejection"');
    expect(daemon).toContain("isExpectedCancellationRejection(reason)");
    expect(daemon).toContain('append("daemon_request_cancellation_observed"');
  });

  it("authenticates startup cancellation before waiting for lifecycle serialization", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const stopBlock = commandBlock(
      source,
      'program\n  .command("stop")',
      'program\n  .command("restart")',
    );
    const startupCancellation = stopBlock.indexOf(
      "await stopStartingOwnedDaemonBeforeLifecycleLock();",
    );
    const lifecycleLock = stopBlock.indexOf("await withDaemonLifecycleLock(");

    expect(startupCancellation).toBeGreaterThanOrEqual(0);
    expect(lifecycleLock).toBeGreaterThan(startupCancellation);
    expect(stopBlock).toContain("{ waitOnContention: true }");

    const helper = commandBlock(
      source,
      "async function stopStartingOwnedDaemonBeforeLifecycleLock()",
      "async function configExists()",
    );
    const directStop = helper.indexOf('await requestDaemonControl(state, "stop");');
    const controlClose = helper.indexOf("await waitForDaemonControlClose(state);", directStop);
    const identityReadback = helper.indexOf(
      "const stopped = await readOmniCodexDaemonState();",
      controlClose,
    );
    const identityCheck = helper.indexOf("!sameDaemonProcess(state, stopped)", identityReadback);
    const exactExit = helper.indexOf(
      "await waitForExactDaemonProcessExit(stopped);",
      identityCheck,
    );

    expect(directStop).toBeGreaterThanOrEqual(0);
    expect(controlClose).toBeGreaterThan(directStop);
    expect(identityReadback).toBeGreaterThan(controlClose);
    expect(identityCheck).toBeGreaterThan(identityReadback);
    expect(exactExit).toBeGreaterThan(identityCheck);
    expect(helper).not.toContain("terminateOwnedHiddenChild");
  });

  it("prepares the exact autostart launcher before restart can drain the live daemon", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const block = commandBlock(
      source,
      'program\n  .command("restart")',
      'program\n  .command("status")',
    );
    const lifecycleLock = block.indexOf(
      "const alreadyCurrent = await withDaemonLifecycleLock(async () => {",
    );
    const launcherPreparation = block.indexOf(
      "await ensureStableReleaseLauncher(true);",
      lifecycleLock,
    );
    const stateRead = block.indexOf(
      "const state = await readOmniCodexDaemonState();",
      launcherPreparation,
    );
    const keyPreparation = block.indexOf("await ensureInternalIntegrityKeysInitialized();");
    const drain = block.indexOf(
      "await drainAndStopOwnedDaemon(state, options.drainTimeout);",
      stateRead,
    );
    const scheduledLaunch = block.indexOf("await launchThroughScheduledTaskWhenEnabled();", drain);

    expect(lifecycleLock).toBeGreaterThanOrEqual(0);
    expect(launcherPreparation).toBeGreaterThan(lifecycleLock);
    expect(stateRead).toBeGreaterThan(launcherPreparation);
    expect(keyPreparation).toBeGreaterThan(launcherPreparation);
    expect(stateRead).toBeGreaterThan(keyPreparation);
    expect(drain).toBeGreaterThan(stateRead);
    expect(scheduledLaunch).toBeGreaterThan(drain);

    const prepare = new Function(
      "ensureStableReleaseLauncher",
      "ensureInternalIntegrityKeysInitialized",
      `return (async () => { ${block.slice(launcherPreparation, stateRead)} })();`,
    );
    const keyFailure = new Error("DPAPI key unavailable");
    const prepareKeys = vi.fn().mockRejectedValue(keyFailure);
    await expect(prepare(vi.fn().mockResolvedValue(undefined), prepareKeys)).rejects.toBe(
      keyFailure,
    );
    expect(prepareKeys).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "stop",
      start: 'program\n  .command("stop")',
      end: 'program\n  .command("restart")',
    },
    {
      name: "restart",
      start: 'program\n  .command("restart")',
      end: 'program\n  .command("status")',
    },
  ])(
    "waits for the exact daemon PID to exit before $name recovery and retirement",
    async (contract) => {
      const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
      const block = commandBlock(source, contract.start, contract.end);
      const controlClose = block.lastIndexOf("await waitForDaemonControlClose(state);");
      const identityReadback = block.indexOf(
        "const stopped = await readOmniCodexDaemonState();",
        controlClose,
      );
      const identityCheck = block.indexOf("!sameDaemonProcess(state, stopped)", identityReadback);
      const processExit = block.indexOf(
        "await waitForExactDaemonProcessExit(stopped);",
        identityCheck,
      );
      const reclaim = block.indexOf(
        "await reclaimOwnedChildrenForStoppedDaemon(stopped);",
        processExit,
      );
      const retire = block.indexOf("await retireStoppedDaemonState(stopped);", reclaim);

      expect(controlClose).toBeGreaterThanOrEqual(0);
      expect(identityReadback).toBeGreaterThan(controlClose);
      expect(identityCheck).toBeGreaterThan(identityReadback);
      expect(processExit).toBeGreaterThan(identityCheck);
      expect(reclaim).toBeGreaterThan(processExit);
      expect(retire).toBeGreaterThan(reclaim);
    },
  );

  it("polls only the recorded daemon PID and accepts only confirmed process absence", async () => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const block = commandBlock(
      source,
      "async function waitForExactDaemonProcessExit(",
      "function requestDaemonControl(",
    );

    expect(block).toContain("probeProcessStatus(state.pid)");
    expect(block).toContain('processStatus === "absent"');
    expect(block).toContain(
      "const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;",
    );
    expect(source).not.toContain("DAEMON_PROCESS_EXIT_TIMEOUT_MS");
    expect(block).not.toContain("terminate");
    expect(block).not.toContain("reclaim");
  });

  it.each([
    {
      name: "runtime switch",
      start: 'runtime\n  .command("switch")',
      end: "const autostart",
      mutation: '"switch-runtime"',
      lockedPreparation: "const state = await requireLiveDaemonState();",
    },
    {
      name: "release update",
      start: 'program\n  .command("update")',
      end: 'program\n  .command("rollback")',
      mutation: ").update(options.targetVersion)",
      lockedPreparation: "await createReleaseController(",
    },
    {
      name: "release rollback",
      start: 'program\n  .command("rollback")',
      end: 'acceptance\n  .command("record")',
      mutation: ").rollback(",
      lockedPreparation: "await createReleaseController(options.drainTimeout)",
    },
  ])("keeps $name previews unlocked and serializes execution", async (contract) => {
    const source = (await readFile(new URL("src/cli.ts", root), "utf8")).replaceAll("\r\n", "\n");
    const block = commandBlock(source, contract.start, contract.end);
    const executeGuard = block.indexOf("if (options.execute !== true)");
    const dryRunReturn = block.indexOf("return;", executeGuard);
    const lifecycleLock = block.indexOf("await withDaemonLifecycleLock(async () => {");
    const lockedPreparation = block.indexOf(contract.lockedPreparation, lifecycleLock);
    const mutation = block.indexOf(contract.mutation, lifecycleLock);

    expect(executeGuard).toBeGreaterThanOrEqual(0);
    expect(dryRunReturn).toBeGreaterThan(executeGuard);
    expect(lifecycleLock).toBeGreaterThan(dryRunReturn);
    expect(lockedPreparation).toBeGreaterThan(lifecycleLock);
    expect(mutation).toBeGreaterThan(lockedPreparation);
    expect(block.match(/withDaemonLifecycleLock/g)).toHaveLength(1);
  });
});
