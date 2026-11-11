import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { daemonLifecycleForGatewayStatus } from "../src/application/daemon-bootstrap-lifecycle.js";

describe("daemon bootstrap lifecycle", () => {
  it("bounds restart-durable native result payloads and lease receipts", async () => {
    const daemon = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    const legacyStart = daemon.indexOf("LegacyMutationCoordinator.open({");
    const legacyEnd = daemon.indexOf("});", legacyStart);
    const leaseStart = daemon.indexOf("DurableNativeResourceLeaseCoordinator.open({");
    const leaseEnd = daemon.indexOf("});", leaseStart);

    expect(legacyStart).toBeGreaterThan(-1);
    expect(legacyEnd).toBeGreaterThan(legacyStart);
    expect(daemon.slice(legacyStart, legacyEnd)).toContain("maxCompletedResults: 64");
    expect(leaseStart).toBeGreaterThan(-1);
    expect(leaseEnd).toBeGreaterThan(leaseStart);
    expect(daemon.slice(leaseStart, leaseEnd)).toContain("maxCompletions: 4_096");
  });

  it("wires native Desktop Goal prepare and dispatch to the existing app renderer", async () => {
    const daemon = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    const start = daemon.indexOf("evaluateDesktopNativeSend: async");
    const end = daemon.indexOf("readDesktopGoalSnapshot: async", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const evaluator = daemon.slice(start, end);
    expect(evaluator).toContain("desktopChatEventSource?.endpoint");
    expect(evaluator).toContain('item.type === "page" && item.url === "app://-/index.html"');
    expect(evaluator).toContain("BoundedCdpSession.connect(");
    expect(evaluator).toContain("timeoutMs: null");
    expect(evaluator).toContain("{ expression, awaitPromise: true, returnByValue: true }");
    expect(evaluator).toContain("session.close()");
    const gateway = await readFile(
      join(process.cwd(), "src", "application", "omnicodex-gateway-service.ts"),
      "utf8",
    );
    const sender = gateway.slice(
      gateway.indexOf("continueDesktopGoal: (target, signal) =>"),
      gateway.indexOf("readDesktopChatScope: async (signal) =>"),
    );
    expect(sender).toContain("prepareDesktopChatNativeSend(");
    expect(sender).toContain("dispatchDesktopChatNativeSend(");
    expect(sender).toContain("recordNativeContinuationReceipt(target, receipt)");
    expect(sender).toContain("canDispatchContinuation(target)");
    expect(sender).toContain("conversationUrl: target.conversationUrl");
  });

  it("binds Desktop observers only to the current desktop account catalog", async () => {
    const source = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    const start = source.indexOf("const readDesktopChatScope =");
    const end = source.indexOf("desktopApprovalObserver =", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const binding = source.slice(start, end);
    expect(binding).toContain("service.readDesktopChatScope(signal)");
    expect(binding).not.toContain("getOracleClientBindings");
    expect(binding).not.toContain("config.oracle");
  });

  it("does not start approval observers or Oracle approval automation in training mode", async () => {
    const daemon = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    expect(daemon).toContain('const trainingMode = config.runtimeMode === "training";');
    expect(daemon).toMatch(/if \(!trainingMode\)\s+desktopApprovalObserver =/u);
    expect(daemon).toMatch(
      /startOracleApprovalAutomation\(transport: OracleTransportRuntime\): Promise<void> \{\s+if \(trainingMode\) return;/u,
    );
  });

  it("does not publish ready before the configured daemon bootstrap is complete", () => {
    expect(daemonLifecycleForGatewayStatus("ready", false)).toBe("starting");
    expect(daemonLifecycleForGatewayStatus("converging", false)).toBe("starting");
  });

  it("publishes gateway readiness only after the bootstrap gate opens", () => {
    expect(daemonLifecycleForGatewayStatus("ready", true)).toBe("ready");
    expect(daemonLifecycleForGatewayStatus("converging", true)).toBe("ready");
    expect(daemonLifecycleForGatewayStatus("recovering", true)).toBe("starting");
    expect(daemonLifecycleForGatewayStatus("retiring_previous", true)).toBe("retiring_previous");
    expect(daemonLifecycleForGatewayStatus("cleanup_pending", true)).toBe("cleanup_pending");
  });

  it("starts binding-specific watchers only after the isolated Oracle CDP tunnel is ready", async () => {
    const source = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    const gatewayStart = source.indexOf("const status = await service.start();");
    const tunnelStart = source.indexOf(
      "await tunnelSupervisor.start(status.address);",
      gatewayStart,
    );
    const bootstrapRelease = source.indexOf("bootstrapComplete = true;", tunnelStart);
    const readyLog = source.indexOf(
      'settledStatus.lifecycle === "ready" ? "daemon_ready"',
      bootstrapRelease,
    );
    const remoteTunnelReady = source.indexOf(
      'operationalLog.append("oracle_remote_cdp_tunnel_ready"',
      readyLog,
    );
    const watcherStart = source.indexOf("startOracleApprovalWatcher(runtime);", remoteTunnelReady);

    expect(gatewayStart).toBeGreaterThan(-1);
    expect(tunnelStart).toBeGreaterThan(gatewayStart);
    expect(bootstrapRelease).toBeGreaterThan(tunnelStart);
    expect(readyLog).toBeGreaterThan(bootstrapRelease);
    expect(remoteTunnelReady).toBeGreaterThan(readyLog);
    expect(watcherStart).toBeGreaterThan(remoteTunnelReady);
    expect(source).not.toContain("new OracleBrowserSupervisor");
    expect(source).toContain("new OracleApprovalPopupWatcher");
    expect(source).toContain("new OracleApprovalOwnershipGuard");
    expect(source).toContain("timeoutMs: ORACLE_APPROVAL_CDP_COMMAND_TIMEOUT_MS");
  });

  it("keeps approval source-independent and never falls back to Loop Chrome", async () => {
    const source = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");

    expect(source).not.toContain("startOracleAuxiliaryInBackground");
    expect(source).not.toContain("scheduleOracleBrowserRecovery");
    expect(source).toContain('approvalWatcherTarget: "oracle_remote_chrome"');
    expect(source).toContain("runtime.watcher?.stop()");
    expect(source).not.toContain("actuateLoopFileMaterializationApproval");
    expect(source).not.toContain("oracle_loop_approval_actuator");
    expect(source).toContain("new OracleChatGptServerApprovalClient");
    expect(source).not.toContain("recoveryScanIntervalMs: 5_000");
    expect(source).toContain("ensureConversationTarget: async (conversationUrl, signal)");
    expect(source).toContain("mirror.prepareForProtectedResult(conversationUrl, signal)");
    expect(source).not.toContain("readChromeUserTabs: () => service.readChromeUserTabs()");
    expect(source).toContain("prepareChatGptConversationRequest: async (input)");
    expect(source).toContain("runtime.watcher?.wake(url, { serverScan: false })");
    expect(source).not.toContain("oracleApprovalWatcher?.wake(observation.chatGptConversationUrl)");
    expect(source).not.toContain("dispatchLoopChromeFileApproval(");
    expect(source).not.toContain("resolveAndDispatchLoopChromeFileApproval(");
    expect(source).not.toContain("ORACLE_LOOP_FILE_APPROVAL_FALLBACK_DELAY_MS");
    expect(source).not.toContain("singleConversationUrlFromChromeInventory(inventory)");
    expect(source).not.toContain(".approveChromeFileMaterialization(chatGptConversationUrl)");
    expect(source).not.toContain("await watcher?.waitUntilConversationReady(");
    const watcherErrorCase = source.slice(
      source.indexOf('case "watcher_error":'),
      source.indexOf('case "watcher_unhealthy":'),
    );
    expect(watcherErrorCase).toContain("oracleApprovalWatcherEventRequiresTunnelRecovery(event)");
    expect(watcherErrorCase).toContain("startOracleRemoteCdpTunnelRecovery(");
  });

  it("keeps the persistent Oracle watcher active during automatic action refresh", async () => {
    const source = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    const refreshStart = source.indexOf("async function runOracleActionCatalogRefresh(");
    expect(source).not.toContain("ORACLE_ACTION_CATALOG_REFRESH_TIMEOUT_MS");
    expect(source).not.toContain("ORACLE_ACTION_CATALOG_REFRESH_CHILD_TIMED_OUT");
    expect(source).not.toContain('"--timeout"');
    expect(source).toContain("oracleCatalogRefreshErrorDetails(error)");
    expect(source).not.toContain("child.stderr?.resume()");
    const refreshEnd = source.indexOf(
      "async function stopOracleActionCatalogAutoRefresh",
      refreshStart,
    );
    const refresh = source.slice(refreshStart, refreshEnd);

    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    expect(refresh).not.toContain("oracleApprovalWatcher = undefined");
    expect(refresh).not.toContain("await watcher?.stop()");
    expect(refresh).toContain(".refreshActionsControlPlane(");
    expect(refresh).toContain("signal: controller.signal");
    expect(refresh).toContain("readStableOracleActionCatalogBaseline({");
    expect(refresh).toContain("...stableCatalogBaseline");
    expect(refresh).not.toContain("lastStateVerification");
    expect(refresh).toContain("oracleActionCatalogCdpRecoveryRequired(error)");
    expect(refresh).not.toContain("spawnHidden");
    expect(refresh).not.toContain("runOracleSettingsTargetPhases");
    expect(source).toContain("oracleActionCatalogRefreshAbort?.abort(");
  });

  it("reconciles live transport readiness before an explicit catalog refresh", async () => {
    const source = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    const start = source.indexOf('if (command === "refresh-action-catalog")');
    const end = source.indexOf('if (command === "thread-inventory")', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    expect(handler).toContain("oracleActionCatalogRefreshTransportsReady()");
    expect(handler).toContain("await oracleActionCatalogAutoRefresh.markEndpointReady()");
    expect(handler).toContain('synchronize(\n            "manual_refresh"');
  });

  it("fences runtime publication before bounded shutdown work and always retires control ingress", async () => {
    const source = await readFile(join(process.cwd(), "src", "daemon.ts"), "utf8");
    const shutdownStart = source.indexOf("function shutdown(");
    const shutdownEnd = source.indexOf("async function persistState", shutdownStart);
    const shutdown = source.slice(shutdownStart, shutdownEnd);
    const ownershipFence = shutdown.indexOf(
      "const ownedRuntimeStop = service.stop(shutdownTimeoutMs);",
    );
    const asynchronousSequence = shutdown.indexOf("const operation = performShutdown(");

    expect(shutdownStart).toBeGreaterThan(-1);
    expect(shutdownEnd).toBeGreaterThan(shutdownStart);
    expect(ownershipFence).toBeGreaterThan(-1);
    expect(asynchronousSequence).toBeGreaterThan(ownershipFence);
    expect(shutdown).toContain("runBoundedShutdownSequence");
    expect(shutdown).toContain("const shutdownTimeoutMs = operatorTimeoutMs");
    expect(shutdown).not.toContain("DEFAULT_DAEMON_SHUTDOWN_TIMEOUT_MS");
    expect(shutdown).toContain("closeControlServer(controlServer)");
    expect(shutdown).toContain("process.exit(finalExitCode)");
    expect(shutdown).not.toContain("stopping = false");
  });

  it("retires session executors before the stable primary App Server transport", async () => {
    const source = await readFile(
      join(process.cwd(), "src", "application", "omnicodex-gateway-service.ts"),
      "utf8",
    );
    const stopChildrenStart = source.indexOf("stopChildren: async () => {");
    const stopChildrenEnd = source.indexOf(
      'throw new AggregateError(errors, "OmniCodex owned runtime did not stop cleanly")',
      stopChildrenStart,
    );
    const stopChildren = source.slice(stopChildrenStart, stopChildrenEnd);
    const sessionExecutorsStop = stopChildren.indexOf(
      "ownedSessionExecutorPool.close({ preserveBrowserActivities: true })",
    );
    const primaryTransportStop = stopChildren.indexOf("ownedPrimary.stop()");

    expect(stopChildrenStart).toBeGreaterThan(-1);
    expect(stopChildrenEnd).toBeGreaterThan(stopChildrenStart);
    expect(sessionExecutorsStop).toBeGreaterThan(-1);
    expect(primaryTransportStop).toBeGreaterThan(sessionExecutorsStop);
  });
});
