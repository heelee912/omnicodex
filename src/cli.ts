#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { closeSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { access, mkdir, readFile, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Command } from "commander";
import {
  assessUnreachableDaemonState,
  type ProcessStatus,
  probeProcessStatus,
  quarantineStaleDaemonState,
  retireStoppedDaemonState,
  withDaemonLifecycleLock,
} from "./application/daemon-state-recovery.js";
import {
  OmniCodexGatewayService,
  type OmniCodexThreadInventorySnapshot,
} from "./application/omnicodex-gateway-service.js";
import type {
  OracleActionCatalogAutoRefreshResult,
  OracleClientBindingsActionCatalogAutoRefreshResult,
} from "./application/oracle-action-catalog-auto-refresh.js";
import { OracleAdapterService } from "./application/oracle-adapter-service.js";
import {
  type OracleDaemonRuntimeStatus,
  oracleClientRuntimeStatus,
  oraclePublicMcpReady,
} from "./application/oracle-runtime-status.js";
import { runOracleSettingsTargetPhases } from "./application/oracle-settings-target-lifecycle.js";
import {
  evaluateOmniCodexAcceptance,
  type OmniCodexAcceptanceStage,
} from "./application/release-acceptance.js";
import { ReleaseTransitionController } from "./application/release-transition-controller.js";
import { Auth0CliInstaller, Auth0CliManagementClient } from "./infrastructure/auth/auth0-cli.js";
import {
  Auth0DcrClientJanitor,
  type Auth0DcrClientSummary,
} from "./infrastructure/auth/auth0-dcr-client-janitor.js";
import { Auth0ManagementProvisioner } from "./infrastructure/auth/auth0-management-provisioner.js";
import { ChatGptActionCatalogControlClient } from "./infrastructure/chatgpt/chatgpt-action-catalog-control-client.js";
import { CdpChatGptSettingsSurface } from "./infrastructure/chatgpt/chatgpt-app-settings-reconciler.js";
import {
  type CdpTarget,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
  connectActivatedOwnedSettingsSession,
  DEFAULT_CDP_FRAME_BUDGET_BYTES,
} from "./infrastructure/chatgpt/chatgpt-cdp-transport.js";
import {
  assertGatewayConfigured,
  loadOmniCodexConfig,
  loadOptionalOmniCodexConfig,
  mergeGatewayInitialization,
  OMNICODEX_MCP_SURFACE,
  type OmniCodexConfig,
  type OmniCodexDaemonState,
  type OmniCodexOracleConfig,
  omniCodexConfigPath,
  omniCodexDataDirectory,
  readOmniCodexDaemonState,
  saveOmniCodexConfig,
  selectOracleClientConfig,
} from "./infrastructure/config/omnicodex-config-store.js";
import { ensureOmniCodexInternalIntegrityKeys } from "./infrastructure/config/omnicodex-internal-integrity-key.js";
import {
  OMNICODEX_FULL_CATALOG_PRIORITY,
  type OmniCodexFullCatalogSnapshot,
} from "./infrastructure/mcp/omnicodex-mcp-server.js";
import type {
  AuthoritativeActionRefreshResult,
  LiveLocalCatalogBaseline,
} from "./infrastructure/operations/chatgpt-action-catalog-refresh-verifier.js";
import { OmniCodexOperationalLog } from "./infrastructure/operations/operational-log.js";
import {
  CallbackReleaseAdmissionDrain,
  CallbackReleaseObservation,
  LocalReleasePointer,
  LocalReleaseStateSnapshots,
} from "./infrastructure/release/local-release-runtime.js";
import {
  NpmReleaseSource,
  NpmReleaseValidator,
} from "./infrastructure/release/npm-release-source.js";
import {
  parseAcceptanceArtifact,
  ReleaseAcceptanceStore,
} from "./infrastructure/release/release-acceptance-store.js";
import {
  computeOmniCodexReleaseFingerprint,
  isSameOmniCodexReleaseBuild,
} from "./infrastructure/release/release-build-fingerprint.js";
import { StableReleaseLauncher } from "./infrastructure/release/stable-release-launcher.js";
import {
  omniCodexRuntimeInstanceId,
  prepareOmniCodexRuntimeWriteEnvironment,
  removeOmniCodexRuntimeWriteEnvironment,
} from "./infrastructure/runtime/omnicodex-runtime-write-environment.js";
import { HashChainedActionLedger } from "./infrastructure/safety/hash-chained-action-ledger.js";
import { observeProtectedFile } from "./infrastructure/safety/protected-file-snapshot.js";
import { WindowsCodexBoundaryGuard } from "./infrastructure/safety/windows-codex-boundary-guard.js";
import { NgrokInstaller } from "./infrastructure/tunnel/ngrok-installer.js";
import { CodexRuntimeDiscovery } from "./infrastructure/windows/codex-runtime-discovery.js";
import type { DesktopChatEventObservationStatus } from "./infrastructure/windows/desktop-chat-event-source.js";
import {
  configureDefaultHiddenChildActionLedger,
  type OwnedHiddenChildProcess,
  spawnHidden,
  terminateOwnedHiddenChild,
} from "./infrastructure/windows/hidden-child-process.js";
import {
  WindowsAutostartManager,
  type WindowsAutostartStatus,
} from "./infrastructure/windows/windows-autostart-manager.js";
import { WindowsDpapiSecretStore } from "./infrastructure/windows/windows-dpapi-secret-store.js";
import { WindowsStaleCodexAppServerReclaimer } from "./infrastructure/windows/windows-stale-codex-app-server-reclaimer.js";
import { WindowsStaleNgrokReclaimer } from "./infrastructure/windows/windows-stale-ngrok-reclaimer.js";

const CLI_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const releaseGateNames = [
  "package_identity",
  "registry_integrity",
  "signature_and_provenance",
  "sbom_association",
  "self_checks",
  "state_migration_dry_run",
  "guard_self_test",
  "protocol_contract",
  "shadow_runtime_probe",
  "active_request_drain",
  "atomic_pointer_switch",
  "post_switch_observation",
] as const;

const FUNCTIONS_EXEC_INPUT_SCHEMA = {
  type: "object",
  properties: {
    input: { type: "string" },
  },
  required: ["input"],
  additionalProperties: false,
} as const;

const FUNCTIONS_EXEC_NESTED_CAPABILITIES = [
  { capability: "thread/list", name: "codex_app__list_threads" },
  { capability: "thread/archived/list", name: "codex_app__list_archived_threads" },
  { capability: "thread/turns/list", name: "codex_app__read_thread" },
  { capability: "thread/follow-up", name: "codex_app__send_message_to_thread" },
  { capability: "fs/readFile", name: "codex__app_server__fs_readFile" },
  { capability: "fs/writeFile", name: "codex__app_server__fs_writeFile" },
  { capability: "command/exec", name: "codex__app_server__command_exec" },
  { capability: "mcpServer/tool/call:node_repl/js", name: "mcp__node_repl__js" },
  { capability: "browser surface discovery", name: "browser__list_surfaces" },
  { capability: "Chrome Use visible tab discovery", name: "chrome__list_user_tabs" },
  { capability: "Chrome Use extension control", name: "chrome__control_chrome" },
  { capability: "Codex in-app browser control", name: "browser__control_in_app_browser" },
] as const;

const FUNCTIONS_EXEC_DIRECT_CALLS = [
  { capability: "thread/list", name: "codex_app__list_threads" },
  { capability: "mcpServer/tool/call:node_repl/js", name: "mcp__node_repl__js" },
  { capability: "browser surface discovery", name: "browser__list_surfaces" },
] as const;

export const OMNICODEX_REQUIRED_DIRECT_WORK_TOOLS = [
  {
    name: "codex_app__list_threads",
    route: "codex_app_native",
    nativeNamespace: "codex_app",
    nativeName: "codex_app/list_threads",
  },
  {
    name: "codex_app__read_thread",
    route: "codex_app_native",
    nativeNamespace: "codex_app",
    nativeName: "codex_app/read_thread",
  },
  {
    name: "codex__app_server__fs_readFile",
    route: "app_server_rpc",
    nativeNamespace: "app_server",
    nativeName: "fs/readFile",
  },
  {
    name: "codex__app_server__fs_writeFile",
    route: "app_server_rpc",
    nativeNamespace: "app_server",
    nativeName: "fs/writeFile",
  },
  {
    name: "codex__app_server__command_exec",
    route: "app_server_rpc",
    nativeNamespace: "app_server",
    nativeName: "command/exec",
  },
  {
    name: "codex__node_repl__js",
    route: "downstream_direct",
    nativeNamespace: "node_repl",
    nativeName: "js",
  },
  ...[
    "list_apps",
    "list_windows",
    "get_window",
    "launch_app",
    "get_window_state",
    "click",
    "press_key",
    "type_text",
    "scroll",
    "set_value",
    "drag",
    "perform_secondary_action",
    "activate_window",
  ].map((method) => ({
    name: `codex__computer_use__${method}`,
    route: "computer_use_native",
    nativeNamespace: "codex.computer_use",
    nativeName: `codex.computer_use.${method}`,
  })),
] as const;

export function assertRequiredDirectWorkToolCatalog(tools: readonly Tool[]): void {
  for (const expected of OMNICODEX_REQUIRED_DIRECT_WORK_TOOLS) {
    const matches = tools.filter((candidate) => candidate.name === expected.name);
    const tool = matches[0];
    if (matches.length !== 1 || tool === undefined || tool.inputSchema.type !== "object") {
      throw new Error(`Installed runtime omitted the direct native work tool ${expected.name}`);
    }
  }
}

let actionLedgerPath: string | undefined;
function prepareActionLedger(): string {
  actionLedgerPath ??= configureDefaultHiddenChildActionLedger(
    join(omniCodexDataDirectory(), "logs", `action-ledger-${process.pid}-${Date.now()}.jsonl`),
  );
  return actionLedgerPath;
}

const NODE_MAX_TIMER_DELAY_MS = 2_147_483_647;

const program = new Command()
  .name("omnicodex")
  .description("Authenticated MCP access to the installed Codex native tool surface")
  .version("0.0.0-development")
  .hook("preAction", () => {
    prepareActionLedger();
  });

const acceptance = program
  .command("acceptance")
  .description(
    "Record and verify same-build release evidence; never gates runtime or Goal progress",
  );

program
  .command("init")
  .description("Create a fail-closed local gateway configuration")
  .option("--issuer <url>", "OIDC issuer URL")
  .option("--audience <value>", "OIDC API audience")
  .option("--resource <url>", "OAuth protected resource URL")
  .option("--subject <sub...>", "allowed owner subject(s)")
  .option("--scope <scope...>", "required scope(s)", ["omnicodex:full"])
  .option("--jwks-uri <url>", "explicit JWKS URL")
  .option("--root <path>", "default local project root", process.cwd())
  .option("--port <number>", "loopback MCP port", parsePort, 8787)
  .option("--allowed-origin <origin...>", "allowed browser origins", [])
  .option("--local-only", "initialize only the optional Oracle companion")
  .option("--non-interactive", "fail instead of prompting")
  .option("--execute", "persist local-only initialization")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: InitOptions) => {
    if (options.localOnly === true) {
      if (options.nonInteractive !== true)
        throw new Error("--local-only requires --non-interactive");
      const config: OmniCodexConfig = {
        schemaVersion: 1,
        companionOnly: true,
        projectRoot: resolve(options.root),
        gateway: {
          host: "127.0.0.1",
          port: options.port,
          path: "/mcp",
          fullPath: "/mcp/full",
          allowedOrigins: [],
        },
        auth: { issuer: "", audience: "", requiredScopes: [], allowedSubjects: [] },
      };
      if (options.execute === true) {
        await saveOmniCodexConfig(config);
        const readback = await loadOmniCodexConfig();
        if (JSON.stringify(readback) !== JSON.stringify(config))
          throw new Error("Companion-only config authoritative readback failed");
      }
      emit(
        {
          ok: true,
          executed: options.execute === true,
          configPath: omniCodexConfigPath(),
          mode: "companion-only",
        },
        options.json === true,
        options.execute === true
          ? "Initialized the local Oracle companion; gateway remains unconfigured."
          : "Local-only initialization dry-run complete; use --execute to persist.",
      );
      return;
    }
    const answers = await completeInitOptions(options);
    const nextConfig: OmniCodexConfig = {
      schemaVersion: 1,
      projectRoot: resolve(answers.root),
      gateway: {
        host: "127.0.0.1",
        port: answers.port,
        path: "/mcp",
        fullPath: "/mcp/full",
        allowedOrigins: answers.allowedOrigin,
      },
      auth: {
        issuer: normalizeIssuer(answers.issuer),
        audience: answers.audience,
        ...(answers.resource === undefined ? {} : { resource: answers.resource }),
        requiredScopes: answers.scope,
        allowedSubjects: answers.subject,
        ...(answers.jwksUri === undefined ? {} : { jwksUri: answers.jwksUri }),
      },
    };
    const existingConfig = await loadOptionalOmniCodexConfig();
    const config = mergeGatewayInitialization(nextConfig, existingConfig);
    await saveOmniCodexConfig(config);
    emit(
      { ok: true, configPath: omniCodexConfigPath(), config, next: "omnicodex start" },
      options.json === true,
      `Saved fail-closed OmniCodex configuration to ${omniCodexConfigPath()}\nNext: omnicodex start`,
    );
  });

program
  .command("start")
  .description("Start OmniCodex as a hidden per-user process")
  .option("--json", "emit machine-readable JSON")
  .option("--non-interactive", "fail instead of prompting")
  .action(async (options: JsonOptions) => {
    const independent = await launchThroughScheduledTaskWhenEnabled();
    if (independent !== undefined) {
      emit(
        publicDaemonState(independent),
        options.json === true,
        `OmniCodex ready at http://${independent.address?.host}:${independent.address?.port}${independent.address?.path}`,
      );
      await superviseScheduledTaskDaemon(independent);
      return;
    }
    const ready = await withDaemonLifecycleLock(async () => {
      assertGatewayConfigured(await loadOmniCodexConfig());
      const existing = await readOmniCodexDaemonState();
      if (existing !== undefined) {
        if (await daemonOwnershipIsLive(existing)) {
          if (existing.lifecycle === "failed") {
            throw new Error(existing.error ?? "OmniCodex daemon failed and is still exiting");
          }
          const settled =
            existing.lifecycle === "ready"
              ? existing
              : await waitForExistingDaemon(existing, 600_000);
          if (settled.lifecycle === "failed") {
            throw new Error(settled.error ?? "OmniCodex daemon failed during startup");
          }
          emit(
            publicDaemonState(settled),
            options.json === true,
            `OmniCodex is already ${settled.lifecycle} (pid ${settled.pid}).`,
          );
          return settled;
        }
        const recovery = await quarantineStaleDaemonAndOwnedChildren(existing);
        if (!recovery.quarantined) {
          throw new Error(
            recovery.stateChanged === true
              ? "OmniCodex daemon state changed during stale-state recovery; retry safely"
              : "Refusing to replace an OmniCodex daemon whose recorded ownership cannot be verified",
          );
        }
      }
      await ensureInternalIntegrityKeysInitialized();
      const state = await launchDaemon();
      emit(
        publicDaemonState(state),
        options.json === true,
        `OmniCodex ready at http://${state.address?.host}:${state.address?.port}${state.address?.path}`,
      );
      return state;
    });
    // Task Scheduler owns the WScript -> stable launcher -> CLI process tree.
    // Keep that tree alive for exactly as long as its daemon so Windows cannot
    // tear down the detached child when a short-lived start action returns.
    // Interactive and manual-test starts remain one-shot commands.
    await superviseScheduledTaskDaemon(ready);
  });

program
  .command("stop")
  .description("Gracefully stop the hidden OmniCodex process and its owned children")
  .option(
    "--drain-timeout <milliseconds>",
    "caller-selected active-call drain deadline",
    parseRuntimeDrainTimeout,
  )
  .option("--json", "emit machine-readable JSON")
  .action(async (options: DaemonTransitionOptions) => {
    await stopStartingOwnedDaemonBeforeLifecycleLock();
    await withDaemonLifecycleLock(
      async () => {
        const state = await readOmniCodexDaemonState();
        if (state === undefined) {
          emit(
            { stopped: true, alreadyStopped: true },
            options.json === true,
            "OmniCodex is stopped.",
          );
          return;
        }
        if (!(await daemonOwnershipIsLive(state))) {
          if (state.lifecycle === "stopping") {
            await reclaimOwnedChildrenForStoppedDaemon(state);
            const retired = await retireStoppedDaemonState(state);
            if (!retired.retired) {
              throw new Error("Stopped daemon state changed during retirement; retry safely");
            }
            emit(
              { stopped: true, alreadyStopped: true, retiredStoppedState: true },
              options.json === true,
              "OmniCodex is stopped; graceful-stop state was retired.",
            );
            return;
          }
          const recovery = await quarantineStaleDaemonAndOwnedChildren(state);
          if (!recovery.quarantined)
            throw new Error("Refusing to stop a daemon whose ownership cannot be verified");
          emit(
            {
              stopped: true,
              alreadyStopped: true,
              recoveredStaleState: recovery.assessment.reason,
            },
            options.json === true,
            "OmniCodex is stopped; stale daemon state was quarantined.",
          );
          return;
        }
        await drainAndStopOwnedDaemon(state, options.drainTimeout);
        await waitForDaemonControlClose(state);
        const stopped = await readOmniCodexDaemonState();
        if (stopped === undefined || !sameDaemonProcess(state, stopped)) {
          throw new Error("Daemon state changed before graceful-stop retirement");
        }
        await waitForExactDaemonProcessExit(stopped);
        await reclaimOwnedChildrenForStoppedDaemon(stopped);
        const retired = await retireStoppedDaemonState(stopped);
        if (!retired.retired) {
          // A bounded shutdown may truthfully persist `failed` after the exact
          // daemon PID has exited (for example, a late child cleanup error).
          // The normal stopping-state retirement intentionally rejects that
          // lifecycle. Recover it through the existing stale-state quarantine,
          // which revalidates process absence and exact ownership before moving
          // the state aside, instead of leaving every later start wedged.
          const recovery = await quarantineStaleDaemonAndOwnedChildren(stopped);
          if (!recovery.quarantined) {
            throw new Error("Graceful-stop failed-state quarantine was not authoritative");
          }
        }
        emit({ stopped: true, pid: state.pid }, options.json === true, "OmniCodex stopped.");
      },
      { waitOnContention: true },
    );
  });

program
  .command("restart")
  .description("Activate a changed OmniCodex build through a graceful hidden restart")
  .option(
    "--drain-timeout <milliseconds>",
    "caller-selected active-call drain deadline",
    parseRuntimeDrainTimeout,
  )
  .option("--force", "restart even when the exact executable build is already ready")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: DaemonTransitionOptions) => {
    const targetReleasePath = CLI_PROJECT_ROOT;
    const targetReleaseFingerprint = await computeOmniCodexReleaseFingerprint(targetReleasePath);
    const alreadyCurrent = await withDaemonLifecycleLock(async () => {
      // Commit and verify the launcher for this exact CLI build while the old
      // daemon is still serving. If bootstrap preparation fails, restart must
      // fail without draining or stopping the healthy daemon. Preparing it
      // after retirement creates a real outage window and leaves Scheduled
      // Task unable to activate the replacement build.
      await ensureStableReleaseLauncher(true);
      // Validate configuration and unwrap the durable-state key while the
      // current daemon still serves calls. A failed preparation must not
      // retire a healthy daemon, and its latency must not extend the outage.
      await ensureInternalIntegrityKeysInitialized();
      const state = await readOmniCodexDaemonState();
      if (state !== undefined) {
        if (!(await daemonOwnershipIsLive(state))) {
          if (state.lifecycle === "stopping") {
            await reclaimOwnedChildrenForStoppedDaemon(state);
            const retired = await retireStoppedDaemonState(state);
            if (!retired.retired)
              throw new Error("Stopped daemon state changed during restart retirement");
          } else {
            const recovery = await quarantineStaleDaemonAndOwnedChildren(state);
            if (!recovery.quarantined)
              throw new Error("Refusing to restart a daemon whose ownership cannot be verified");
          }
        } else {
          if (state.lifecycle === "failed") {
            throw new Error(state.error ?? "OmniCodex daemon failed and is still exiting");
          }
          if (
            options.force !== true &&
            state.lifecycle === "ready" &&
            isSameOmniCodexReleaseBuild(state, targetReleasePath, targetReleaseFingerprint)
          ) {
            return state;
          }
          await drainAndStopOwnedDaemon(state, options.drainTimeout);
          await waitForDaemonControlClose(state);
          const stopped = await readOmniCodexDaemonState();
          if (stopped === undefined || !sameDaemonProcess(state, stopped)) {
            throw new Error("Daemon state changed before restart retirement");
          }
          await waitForExactDaemonProcessExit(stopped);
          await reclaimOwnedChildrenForStoppedDaemon(stopped);
          const retired = await retireStoppedDaemonState(stopped);
          if (!retired.retired) {
            const recovery = await quarantineStaleDaemonAndOwnedChildren(stopped);
            if (!recovery.quarantined) {
              throw new Error("Restart could not quarantine failed graceful-stop state");
            }
          }
        }
      }
      return undefined;
    });
    if (alreadyCurrent !== undefined) {
      emit(
        {
          ...(publicDaemonState(alreadyCurrent) as Record<string, unknown>),
          restarted: false,
          alreadyCurrent: true,
        },
        options.json === true,
        `OmniCodex build is already ready (pid ${alreadyCurrent.pid}); restart skipped.`,
      );
      return;
    }
    const independent = await launchThroughScheduledTaskWhenEnabled();
    const ready =
      independent ??
      (await withDaemonLifecycleLock(async () => {
        const existing = await readOmniCodexDaemonState();
        if (existing !== undefined) {
          throw new Error("OmniCodex daemon state reappeared before direct restart");
        }
        return launchDaemon();
      }));
    if (!isSameOmniCodexReleaseBuild(ready, targetReleasePath, targetReleaseFingerprint)) {
      throw new Error("Restart did not activate the selected OmniCodex release build");
    }
    emit(
      publicDaemonState(ready),
      options.json === true,
      `OmniCodex restarted (pid ${ready.pid}).`,
    );
  });

program
  .command("status")
  .description("Show the local OmniCodex gateway status")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const [state, runtime] = await Promise.all([
      readOmniCodexDaemonState(),
      new CodexRuntimeDiscovery().discover(),
    ]);
    const observation = await observeDaemonStatus(state);
    const status = {
      configured: await configExists(),
      running: observation.running,
      observation,
      state:
        state === undefined
          ? undefined
          : {
              ...(publicDaemonState(state) as Record<string, unknown>),
              ...(observation.stale
                ? { stale: true, staleReason: observation.reason }
                : { stale: false }),
            },
      runtime,
    };
    emit(status, options.json === true, daemonStatusMessage(observation, state?.pid));
  });

program
  .command("doctor")
  .description("Run read-only checks for configuration, runtime, process, and autostart")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const manager = autostartManager();
    const [state, runtime, autostartState] = await Promise.all([
      readOmniCodexDaemonState(),
      new CodexRuntimeDiscovery().discover(),
      manager.status(),
    ]);
    let configurationError: string | undefined;
    try {
      await loadOmniCodexConfig();
    } catch (error) {
      configurationError = toError(error).message;
    }
    const observation = await observeDaemonStatus(state);
    const result = {
      ok:
        configurationError === undefined &&
        runtime.candidates.length > 0 &&
        observation.running !== null,
      config: configurationError === undefined ? "valid" : "missing_or_invalid",
      ...(configurationError === undefined ? {} : { configurationError }),
      runtimeFound: runtime.candidates.length > 0,
      running: observation.running,
      lifecycle: observation.lifecycle,
      observation,
      ...(observation.controlStatus === "reachable" || state === undefined
        ? {}
        : {
            recordedLifecycle: state?.lifecycle,
            staleState: observation.stale,
            staleStateReason: observation.reason,
          }),
      autostart: autostartState,
    };
    emit(
      result,
      options.json === true,
      observation.running === null
        ? `OmniCodex doctor: ${daemonStatusMessage(observation, state?.pid)}`
        : result.ok
          ? "OmniCodex doctor: OK"
          : "OmniCodex doctor found setup work.",
    );
  });

program
  .command("logs")
  .description("Read metadata-only rotating operational logs")
  .option("--lines <number>", "maximum entries", parsePositiveInteger, 100)
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions & { lines: number }) => {
    const log = new OmniCodexOperationalLog();
    const entries = await log.read(options.lines);
    emit(
      { path: log.path, entries },
      options.json === true,
      entries.length === 0
        ? "No OmniCodex operational log entries."
        : entries.map((entry) => `${entry.timestamp} ${entry.event}`).join("\n"),
    );
  });

const runtime = program.command("runtime").description("Inspect the installed Codex runtime");

const oracle = program
  .command("oracle")
  .description("Manage the optional exact-bound ChatGPT consent adapter");
oracle
  .command("observe-goal <conversationUrl>")
  .description("Observe one existing Goal conversation through its registered account")
  .requiredOption("--client-binding <key>")
  .option("--timeout <milliseconds>", "maximum observation wait", parsePositiveInteger, 30_000)
  .option("--json")
  .action(
    async (
      conversationUrl: string,
      options: JsonOptions & { clientBinding: string; timeout: number },
    ) => {
      const signal = AbortSignal.timeout(options.timeout);
      const response = await requestGoalConversationObservation(
        await requireLiveDaemonState(),
        options.clientBinding,
        conversationUrl,
        signal,
      );
      emit(
        response.runtime?.goalObservation,
        options.json === true,
        JSON.stringify(response.runtime?.goalObservation),
      );
    },
  );
oracle
  .command("setup")
  .option("--client-binding <key>", "independent Chat client registration", "web")
  .requiredOption("--connector-id <id>")
  .requiredOption("--connector-name <name>")
  .requiredOption("--run-id <id>")
  .requiredOption("--resource <url>")
  .requiredOption("--surface <path>")
  .requiredOption("--cdp-endpoint <url>")
  .option("--direct-cdp", "use the CDP endpoint directly without an SSH tunnel")
  .option("--ssh-host <host>", "remote Chrome SSH host")
  .option("--ssh-port <port>", "remote SSH port (default 22)")
  .option("--ssh-user <user>", "remote SSH user")
  .option("--identity-file <path>", "existing SSH identity file")
  .option("--remote-cdp-port <port>", "remote Chrome CDP port")
  .option("--endpoint <url>", "host-registered MCP endpoint")
  .option("--secure-mcp-tunnel-id <id>", "host-registered Secure MCP Tunnel ID")
  .option("--action-version-id <id>", "host-issued action version")
  .option("--execute")
  .option("--non-interactive")
  .option("--json")
  .action(
    async (options: {
      connectorId: string;
      connectorName: string;
      runId: string;
      resource: string;
      surface: string;
      cdpEndpoint: string;
      directCdp?: boolean;
      sshHost?: string;
      sshPort?: string;
      sshUser?: string;
      identityFile?: string;
      remoteCdpPort?: string;
      clientBinding: string;
      endpoint?: string;
      secureMcpTunnelId?: string;
      actionVersionId?: string;
      execute?: boolean;
      json?: boolean;
    }) => {
      if (options.surface !== OMNICODEX_MCP_SURFACE)
        throw new Error(`--surface must be ${OMNICODEX_MCP_SURFACE}`);
      if (options.secureMcpTunnelId !== undefined && options.endpoint !== undefined)
        throw new Error("--secure-mcp-tunnel-id cannot be combined with --endpoint");
      const hasRemote = [
        options.sshHost,
        options.sshPort,
        options.sshUser,
        options.identityFile,
        options.remoteCdpPort,
      ].some((value) => value !== undefined);
      if (options.directCdp && hasRemote)
        throw new Error("--direct-cdp cannot be combined with SSH transport options");
      if (
        hasRemote &&
        [options.sshHost, options.sshUser, options.identityFile, options.remoteCdpPort].some(
          (value) => value === undefined,
        )
      )
        throw new Error(
          "Remote CDP requires --ssh-host, --ssh-user, --identity-file and --remote-cdp-port",
        );
      const remoteCdpTunnel = options.directCdp
        ? null
        : hasRemote
          ? {
              sshHost: options.sshHost ?? "",
              sshPort: Number(options.sshPort ?? 22),
              sshUser: options.sshUser ?? "",
              identityFile: options.identityFile ?? "",
              remoteCdpPort: Number(options.remoteCdpPort),
            }
          : undefined;
      const result = await new OracleAdapterService({ clientBinding: options.clientBinding }).setup(
        {
          ...options,
          surface: options.surface,
          ...(options.secureMcpTunnelId === undefined
            ? {}
            : {
                registration: {
                  kind: "secure_mcp_tunnel" as const,
                  tunnelId: options.secureMcpTunnelId,
                },
              }),
          ...(remoteCdpTunnel === undefined ? {} : { remoteCdpTunnel }),
        },
        options.execute === true,
      );
      emit(
        result,
        options.json === true,
        result.executed
          ? "Oracle adapter configured and read back."
          : "Oracle setup dry-run complete; use --execute to persist.",
      );
    },
  );
oracle
  .command("status")
  .option("--client-binding <key>", "independent Chat client registration", "web")
  .option(
    "--activity-only",
    "read current daemon counters without external probes or catalog hydration",
  )
  .option("--json")
  .action(async (options: JsonOptions & { clientBinding: string; activityOnly?: boolean }) => {
    if (options.activityOnly === true) {
      const state = await readOmniCodexDaemonState();
      if (state === undefined || !(await daemonOwnershipIsLive(state))) {
        throw new Error("OMNICODEX_DAEMON_NOT_RUNNING");
      }
      const response = await requestDaemonControl(state, "oracle-runtime-status");
      const activity = response.runtime?.oracle?.activity;
      if (activity === undefined) throw new Error("OMNICODEX_RUNTIME_ACTIVITY_UNAVAILABLE");
      emit(activity, options.json === true, JSON.stringify(activity, null, 2));
      return;
    }
    const gatewayConfig = await loadOmniCodexConfig();
    const daemonState = await readOmniCodexDaemonState();
    const daemonLive = daemonState !== undefined && (await daemonOwnershipIsLive(daemonState));
    const [runtime, liveCatalog] = daemonLive
      ? await Promise.all([
          requestDaemonControl(daemonState, "oracle-runtime-status").then(
            (response) => response.runtime?.oracle,
          ),
          requestDaemonControl(daemonState, "catalog-baseline").then(
            (response) => response.runtime?.catalogBaseline,
          ),
        ])
      : [undefined, undefined];
    const configured = await new OracleAdapterService({
      clientBinding: options.clientBinding,
    }).status(liveCatalog);
    const publicEndpointReady = await oraclePublicMcpReady(gatewayConfig, daemonState, {
      // Bound this status probe only; this is not a deadline for MCP work.
      signal: AbortSignal.timeout(10_000),
    });
    const clientRuntime = oracleClientRuntimeStatus(runtime, options.clientBinding);
    const configuredComplete =
      configured.complete ||
      (configured.tunnelLiveReadiness === "unverified" &&
        configured.configurationReady &&
        configured.catalogActivated);
    const result = {
      ...configured,
      configuredComplete,
      complete: configuredComplete && clientRuntime?.ready === true && publicEndpointReady,
      daemonLive,
      publicEndpointReady,
      clientRuntime: clientRuntime ?? null,
      runtime: runtime ?? null,
    };
    emit(
      result,
      options.json === true,
      result.enabled ? "Oracle adapter is enabled." : "Oracle adapter is disabled.",
    );
  });
oracle
  .command("disable")
  .option("--client-binding <key>", "independent Chat client registration", "web")
  .option("--execute")
  .option("--non-interactive")
  .option("--json")
  .action(async (options: JsonOptions & { execute?: boolean; clientBinding: string }) => {
    const result = await new OracleAdapterService({ clientBinding: options.clientBinding }).disable(
      options.execute === true,
    );
    emit(
      result,
      options.json === true,
      result.executed
        ? "Oracle adapter disabled; browser and MCP settings unchanged."
        : "Oracle disable dry-run complete.",
    );
  });
oracle
  .command("test")
  .option("--client-binding <key>", "independent Chat client registration", "web")
  .description(
    "Prepare the exact ChatGPT app before Oracle by reconciling Connect, maximum permission, and its live action schemas",
  )
  .option(
    "--timeout <milliseconds>",
    "caller-selected settings reconciliation deadline",
    parseOracleTestTimeout,
  )
  .option("--execute")
  .option("--non-interactive")
  .option("--json")
  .action(
    async (
      options: JsonOptions & { execute?: boolean; timeout?: number; clientBinding: string },
    ) => {
      const service = new OracleAdapterService({ clientBinding: options.clientBinding });
      const status = await service.status();
      if (status.config === null) throw new Error("Oracle adapter is not configured");
      const config = selectOracleClientConfig(await loadOmniCodexConfig(), options.clientBinding);
      const o = config.oracle;
      if (o === undefined) throw new Error("Oracle adapter is not configured");
      const transport = new ChatGptLoopbackCdpTransport({
        endpoint: o.cdpEndpoint,
        oauthAuthorizationOrigins: [config.auth.issuer],
      });
      const binding = {
        appConnectorId: o.connectorId,
        appName: o.connectorName,
        oracleRunId: o.runId,
        sessionId: o.runId,
        correlationId: o.runId,
        mcpServerResource: o.resource,
        mcpSurface: o.surface,
      };
      // Catalog convergence can briefly publish `starting` while the same
      // authenticated daemon and gateway remain live. Do not drop the
      // authoritative pre-click catalog merely because that presentation state
      // changed between CLI startup and the Refresh click. Ownership proof and
      // the catalog-baseline control response are the actual capability checks.
      const daemonState = options.execute === true ? await requireLiveDaemonState() : undefined;
      if (daemonState !== undefined) await readDaemonCatalogBaseline(daemonState);
      const controlClient = new ChatGptActionCatalogControlClient({
        cdpEndpoint: o.cdpEndpoint,
      });
      if (options.execute === true && daemonState !== undefined) {
        const signal =
          options.timeout === undefined ? undefined : AbortSignal.timeout(options.timeout);
        const actionRefresh = await requestOracleActionCatalogSync(
          daemonState,
          options.clientBinding,
          signal,
        );
        if (actionRefresh.state !== "current" && actionRefresh.state !== "refreshed") {
          throw new Error(`ORACLE_ACTION_CATALOG_REFRESH_INCOMPLETE:${actionRefresh.state}`);
        }
        const refreshed = selectOracleClientConfig(
          await loadOmniCodexConfig(),
          options.clientBinding,
        ).oracle;
        if (
          refreshed?.lastStateVerification?.connected !== true ||
          refreshed.lastStateVerification.fullAccess !== true ||
          refreshed.lastStateVerification.resource !== refreshed.resource
        ) {
          throw new Error("ORACLE_ACTION_CATALOG_STATE_READBACK_MISSING");
        }
        const reconcile = {
          state: "reused" as const,
          connected: true,
          fullAccess: true,
          resourceMatched: true,
          connectorMatched: true,
          stateHash: refreshed.lastStateVerification.stateHash,
          receipts: [] as const,
        };
        emit(
          { ...reconcile, actionRefresh },
          options.json === true,
          `Oracle test reused the exact connection; shared action catalog state: ${actionRefresh.state}.`,
        );
        return;
      }
      const phases = await runOracleSettingsTargetPhases({
        execute: options.execute === true,
        ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout }),
        lifecycle: {
          open: async (budget) => {
            let firstFailure: Error | undefined;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              let target: CdpTarget | undefined;
              try {
                // Acquire the replacement before reclaiming stale settings pages.
                // Oracle Chrome runs without a startup window and exits when its
                // last page is closed; closing first used to tear down the browser
                // and its remote CDP tunnel in the middle of reconciliation.
                const openedTarget = await transport.openOwnedSettingsTarget(
                  o.connectorId,
                  budget.signal,
                );
                target = openedTarget;
                if (attempt === 0) {
                  await transport.closeOrphanedSettingsTargets(o.connectorId, budget.signal, [
                    openedTarget.id,
                  ]);
                }
                const activated = await connectActivatedOwnedSettingsSession(
                  transport,
                  {
                    factory: (url) => new WebSocket(url) as unknown as CdpWebSocketLike,
                    targetId: openedTarget.id,
                    timeoutMs: 10_000,
                    // The exact app detail can expose hundreds of live native actions.
                    // Use the transport's bounded large-catalog budget rather than a
                    // call-site ceiling that can drift below valid catalog frames.
                    maxFrameBytes: DEFAULT_CDP_FRAME_BUDGET_BYTES,
                  },
                  budget.signal,
                );
                const session = activated.session;
                const surface = new CdpChatGptSettingsSurface(
                  transport,
                  session,
                  binding,
                  activated.initialNavigationHistory,
                  (signal) =>
                    connectActivatedOwnedSettingsSession(
                      transport,
                      {
                        factory: (url) => new WebSocket(url) as unknown as CdpWebSocketLike,
                        targetId: openedTarget.id,
                        timeoutMs: 10_000,
                        maxFrameBytes: DEFAULT_CDP_FRAME_BUDGET_BYTES,
                      },
                      signal,
                    ),
                );
                await surface.ensureSettingsIndex(budget.signal);
                return {
                  targetId: openedTarget.id,
                  surface,
                  closeSession: () => surface.closeSession(),
                };
              } catch (error) {
                if (target !== undefined) {
                  await transport
                    .closeOwnedTarget(target.id, AbortSignal.timeout(10_000))
                    .catch(() => undefined);
                }
                const failure = error instanceof Error ? error : new Error(String(error));
                if (attempt === 1 || budget.signal?.aborted === true) {
                  if (firstFailure === undefined) throw failure;
                  throw new AggregateError(
                    [firstFailure, failure],
                    "ORACLE_SETTINGS_TARGET_ACQUIRE_FAILED_AFTER_RETRY",
                  );
                }
                firstFailure = failure;
                await delay(250);
              }
            }
            throw new Error("ORACLE_SETTINGS_TARGET_ACQUIRE_STATE_INVALID");
          },
          closeTarget: (targetId) =>
            transport.closeOwnedTarget(targetId, AbortSignal.timeout(10_000)),
        },
        reconcile: (surface, budget) => {
          const timeoutMs = budget.remainingMs();
          return service.reconcile(
            surface,
            options.execute === true,
            { sessionId: o.runId, correlationId: o.runId },
            {
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              pollIntervalMs: 250,
              ...(budget.signal === undefined ? {} : { signal: budget.signal }),
            },
          );
        },
        reuseTargetForRefresh: () => true,
        refresh: (_surface, budget) => {
          const timeoutMs = budget.remainingMs();
          return service.refreshActionsControlPlane(
            controlClient,
            { sessionId: o.runId, correlationId: o.runId },
            {
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              pollIntervalMs: 250,
              ...(budget.signal === undefined ? {} : { signal: budget.signal }),
              ...(daemonState === undefined
                ? {}
                : {
                    expectedDaemonPid: daemonState.pid,
                    readLocalCatalogBaseline: () => readDaemonCatalogBaseline(daemonState),
                  }),
            },
          );
        },
      });
      const result = phases.reconcile;
      const actionRefresh: AuthoritativeActionRefreshResult | undefined = phases.refresh;
      emit(
        { ...result, ...(actionRefresh === undefined ? {} : { actionRefresh }) },
        options.json === true,
        options.execute === true
          ? "Oracle test authoritatively reconciled the exact ChatGPT app connection, full access, and live critical action schemas."
          : "Oracle test dry-run inspected the exact app settings; no control was clicked.",
      );
    },
  );
runtime
  .command("discover")
  .description("Discover Codex executables without starting any process")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const report = await new CodexRuntimeDiscovery().discover();
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }
    if (report.candidates.length === 0) {
      process.stdout.write("No installed Codex runtime was found.\n");
    } else {
      for (const [index, candidate] of report.candidates.entries()) {
        process.stdout.write(
          `${index + 1}. ${candidate.canonicalPath} [${candidate.source}]${candidate.productVersion === undefined ? "" : ` v${candidate.productVersion}`}\n`,
        );
      }
    }
    for (const warning of report.warnings) process.stdout.write(`Warning: ${warning}\n`);
  });

runtime
  .command("chat-events")
  .description("Verify passive Chat event attachment to the running desktop app")
  .option("--json")
  .action(async (options: JsonOptions) => {
    const state = await readOmniCodexDaemonState();
    if (state === undefined || !(await daemonOwnershipIsLive(state)))
      throw new Error("OMNICODEX_DAEMON_NOT_RUNNING");
    const response = await requestDaemonControl(state, "desktop-chat-events");
    const result = response.runtime?.desktopChatEvents;
    if (result === undefined) throw new Error("DESKTOP_CHAT_EVENT_STATUS_MISSING");
    emit(result, options.json === true, JSON.stringify(result, null, 2));
  });

runtime
  .command("call")
  .description(
    "Call one tool through the running daemon's exact /mcp/full gateway without starting another App Server",
  )
  .argument("<tool-name>", "exact advertised MCP tool name")
  .option("--arguments <json>", "JSON object passed as tool arguments", "{}")
  .option(
    "--timeout <milliseconds>",
    "caller-selected total deadline; omitted calls wait without a product deadline",
    parseRuntimeCallTimeout,
  )
  .option("--json", "emit the complete MCP result as machine-readable JSON")
  .action(
    async (
      toolName: string,
      options: JsonOptions & { readonly arguments: string; readonly timeout?: number },
    ) => {
      const state = await readOmniCodexDaemonState();
      if (state === undefined || !(await daemonOwnershipIsLive(state))) {
        throw new Error("OmniCodex daemon is not running");
      }
      if (state.lifecycle !== "ready" || state.address === undefined) {
        throw new Error(`OmniCodex daemon is not ready (${state.lifecycle})`);
      }
      const argumentsObject = parseRuntimeToolArguments(options.arguments);
      const endpoint = new URL(
        state.address.fullPath,
        `http://${formatHttpHost(state.address.host)}:${String(state.address.port)}`,
      );
      const client = new Client({
        name: "omnicodex-local-operator",
        version: program.version() ?? "0.0.0-development",
      });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${state.controlToken}` } },
      });
      let connected = false;
      try {
        await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
        connected = true;
        const result = await client.callTool(
          { name: toolName, arguments: argumentsObject },
          undefined,
          runtimeCallRequestOptions(options.timeout),
        );
        process.stdout.write(
          options.json === true
            ? `${JSON.stringify(result)}\n`
            : `${JSON.stringify(result, null, 2)}\n`,
        );
        if (result.isError === true) process.exitCode = 1;
      } finally {
        await closeRuntimeCallSession(client, transport, connected);
      }
    },
  );

runtime
  .command("probe")
  .description(
    "Start an isolated hidden runtime and verify the complete first-class native catalog and representative native routes",
  )
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const protectedTargets = [
      { logicalName: "codex-auth", path: join(homedir(), ".codex", "auth.json") },
      { logicalName: "codex-config", path: join(homedir(), ".codex", "config.toml") },
    ];
    const protectedBefore = await Promise.all(protectedTargets.map(observeProtectedFile));
    const resource = "https://omnicodex.invalid/mcp/full";
    const runtimeProbeOwner = {
      pid: process.pid,
      startedAtUnixMs: Date.now(),
      instanceNonce: randomBytes(16).toString("base64url"),
    };
    const runtimeProbeInstanceId = omniCodexRuntimeInstanceId(runtimeProbeOwner);
    const runtimeEnvironment = await prepareOmniCodexRuntimeWriteEnvironment({
      dataDirectory: omniCodexDataDirectory(),
      instanceId: runtimeProbeInstanceId,
    });
    const service = new OmniCodexGatewayService({
      cwd: process.cwd(),
      port: 0,
      runtimeEnvironment: async () => runtimeEnvironment,
      protectedResourceMetadata: {
        resource,
        authorization_servers: ["https://omnicodex.invalid/"],
        scopes_supported: ["omnicodex:full"],
        bearer_methods_supported: ["header"],
      },
      nonInterferenceBoundary: new WindowsCodexBoundaryGuard({
        actionLedger: new HashChainedActionLedger(prepareActionLedger()),
      }),
      authorize: () => ({
        ok: true,
        identity: {
          issuer: "urn:omnicodex:runtime-probe",
          subject: "local-owner",
          clientId: "omnicodex-runtime-probe",
          resource,
        },
        authInfo: {
          token: "local-runtime-probe",
          clientId: "omnicodex-runtime-probe",
          scopes: ["omnicodex:full"],
          resource: new URL(resource),
          extra: { issuer: "urn:omnicodex:runtime-probe", subject: "local-owner" },
        },
      }),
    });
    let client: Client | undefined;
    try {
      const status = await service.start();
      if (status.address === undefined) throw new Error("Runtime probe gateway has no address");
      if (status.bridgeRegistryCurrent !== true) {
        throw new Error(
          `Runtime probe Bridge registry is not current (${status.bridgeDisposition ?? "unknown"})`,
        );
      }
      client = new Client({
        name: "omnicodex-runtime-probe",
        version: program.version() ?? "0.0.0-development",
      });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://${status.address.host}:${status.address.port}${status.address.fullPath}`),
          { requestInit: { headers: { Authorization: "Bearer local-runtime-probe" } } },
        ) as unknown as Parameters<Client["connect"]>[0],
      );
      // Refresh the shared daemon-owned registry first, then read the public
      // pages from that exact generation. Doing this in the opposite order can
      // compare an earlier public revision with a freshly refreshed local one.
      const localCatalog = await service.readFullCatalogSnapshot();
      const catalog = await listCompleteToolCatalog(client);
      const tools = catalog.tools;
      const publicCatalog = assertFullNativeCatalog(tools, catalog.pageToolCounts, localCatalog);
      const execProbe = await probeFunctionsExec(client);
      await client.close();
      client = undefined;
      await service.stop();
      const protectedAfter = await Promise.all(protectedTargets.map(observeProtectedFile));
      const protectedFilesUnchanged = protectedBefore.every((before, index) => {
        const after = protectedAfter[index];
        return (
          after !== undefined &&
          before.logicalName === after.logicalName &&
          before.status === after.status &&
          before.sha256 === after.sha256 &&
          before.sizeBytes === after.sizeBytes
        );
      });
      if (!protectedFilesUnchanged)
        throw new Error("Codex protected files changed during runtime probe");
      const result = {
        ok: true,
        candidate: status.candidate?.canonicalPath,
        appServerMethodCount: status.appServerMethodCount,
        downstreamToolCount: status.downstreamToolCount,
        responsesToolCount: status.responsesToolCount,
        hostToolCount: status.hostToolCount,
        bridgeThreadId: status.bridgeThreadId,
        bridgeDisposition: status.bridgeDisposition,
        bridgeRegistryCurrent: status.bridgeRegistryCurrent,
        fullToolCount: localCatalog.catalogToolCount,
        uniqueToolNames: new Set(localCatalog.catalogToolNames).size,
        publicActionToolCount: tools.length,
        modelToolCount: localCatalog.modelToolCount,
        unknownModelEffectCount: localCatalog.unknownModelEffectCount,
        publicCatalog,
        functionsExec: execProbe,
        protectedFilesUnchanged,
      };
      emit(
        result,
        options.json === true,
        `OmniCodex runtime probe passed (${tools.length} tools).`,
      );
    } finally {
      await client?.close().catch(() => undefined);
      try {
        await service.stop();
      } finally {
        await removeOmniCodexRuntimeWriteEnvironment({
          dataDirectory: omniCodexDataDirectory(),
          instanceId: runtimeProbeInstanceId,
        });
      }
    }
  });

runtime
  .command("switch")
  .description("Shadow probe, drain, switch, observe, and roll back one discovered Codex runtime")
  .requiredOption("--candidate <absolute-path>", "exact discovered Codex executable")
  .option(
    "--drain-timeout <milliseconds>",
    "caller-selected active-call drain deadline",
    parseRuntimeDrainTimeout,
  )
  .option("--execute", "perform the runtime transition")
  .option("--non-interactive", "fail instead of prompting")
  .option("--json", "emit machine-readable JSON")
  .action(
    async (options: {
      candidate: string;
      drainTimeout?: number;
      execute?: boolean;
      nonInteractive?: boolean;
      json?: boolean;
    }) => {
      const candidatePath = resolve(options.candidate);
      const report = await new CodexRuntimeDiscovery().discover();
      const selected = report.candidates.find(
        (candidate) =>
          resolve(candidate.canonicalPath).toLocaleLowerCase("en-US") ===
          candidatePath.toLocaleLowerCase("en-US"),
      );
      if (selected === undefined) {
        throw new Error("Selected runtime is not an installed discovery candidate");
      }
      if (options.execute !== true) {
        const state = await requireLiveDaemonState();
        if (
          state.runtimePath !== undefined &&
          resolve(state.runtimePath).toLocaleLowerCase("en-US") ===
            candidatePath.toLocaleLowerCase("en-US")
        ) {
          throw new Error("Selected Codex runtime is already active");
        }
        emit(
          {
            execute: false,
            activeRuntimePath: state.runtimePath ?? null,
            candidate: selected,
            drainTimeoutMs: options.drainTimeout,
            observationMs: 600_000,
          },
          options.json === true,
          `Runtime switch dry-run: ${selected.canonicalPath}`,
        );
        return;
      }
      await withDaemonLifecycleLock(async () => {
        const state = await requireLiveDaemonState();
        if (
          state.runtimePath !== undefined &&
          resolve(state.runtimePath).toLocaleLowerCase("en-US") ===
            candidatePath.toLocaleLowerCase("en-US")
        ) {
          throw new Error("Selected Codex runtime is already active");
        }
        // A Web conversation outlives this daemon. Only admitted MCP requests
        // participate in the runtime drain; an idle or recovering browser turn
        // must reconnect to the selected runtime instead of blocking the switch.
        const response = await requestDaemonControl(
          state,
          "switch-runtime",
          options.drainTimeout,
          selected.canonicalPath,
        );
        const authoritative = await requireLiveDaemonState();
        if (
          authoritative.runtimePath === undefined ||
          resolve(authoritative.runtimePath).toLocaleLowerCase("en-US") !==
            candidatePath.toLocaleLowerCase("en-US")
        ) {
          throw new Error("Runtime switch state readback did not match the selected candidate");
        }
        emit(
          {
            execute: true,
            runtimePath: authoritative.runtimePath,
            lifecycle: authoritative.lifecycle,
            admission: response.runtime?.admission ?? null,
            activeMcpRequests: response.runtime?.activeMcpRequests ?? null,
            observationMs: 600_000,
          },
          options.json === true,
          `Runtime switch completed: ${authoritative.runtimePath}`,
        );
      });
    },
  );

const autostart = program
  .command("autostart")
  .description("Manage hidden per-user startup at Windows logon");

for (const action of ["enable", "disable", "status", "test", "launch"] as const) {
  autostart
    .command(action)
    .description(`${action[0]?.toUpperCase()}${action.slice(1)} OmniCodex logon startup`)
    .option("--json", "emit machine-readable JSON")
    .action(async (options: JsonOptions) => {
      if (action === "enable" || action === "test" || action === "launch") {
        await withDaemonLifecycleLock(ensureInternalIntegrityKeysInitialized);
      }
      if (action === "enable") await ensureStableReleaseLauncher();
      const manager = new WindowsAutostartManager({
        ...autostartManagerOptions(),
      });
      const result = await manager[action]();
      emit(
        result,
        options.json === true,
        result.enabled
          ? `OmniCodex autostart is enabled (${result.taskName}).`
          : "OmniCodex autostart is disabled.",
      );
    });
}

const auth = program.command("auth").description("Provision and inspect owner-only OAuth access");

const auth0ManagementScopes = [
  "read:resource_servers",
  "create:resource_servers",
  "update:resource_servers",
  "read:client_grants",
  "create:client_grants",
  "update:client_grants",
  "read:tenant_settings",
  "update:tenant_settings",
  "read:clients",
  "delete:clients",
] as const;

auth
  .command("login")
  .description("Sign in through the official Auth0 CLI device flow and Windows keyring")
  .option("--tenant <origin>", "Auth0 tenant origin; defaults to the configured issuer")
  .option("--auth0-cli <path>", "existing official Auth0 CLI executable")
  .option(
    "--device-url-stdout",
    "emit the bounded short-lived device URL as JSONL instead of opening the system browser",
  )
  .option(
    "--device-url-handoff",
    "write the bounded short-lived device URL to the owner-only OmniCodex handoff file",
  )
  .option("--json", "emit machine-readable JSON after login completes")
  .action(async (options: AuthLoginOptions) => {
    const config = await loadOptionalOmniCodexConfig();
    const tenant =
      options.tenant ??
      (config === undefined || config.auth.issuer.length === 0 ? undefined : config.auth.issuer);
    const executable = await new Auth0CliInstaller({
      dataDirectory: omniCodexDataDirectory(),
    }).ensure(options.auth0Cli);
    if (options.deviceUrlStdout === true && options.deviceUrlHandoff === true) {
      throw new Error("Choose only one Auth0 device URL handoff mode");
    }
    const handoffPath =
      options.deviceUrlHandoff === true
        ? join(omniCodexDataDirectory(), "state", "auth0-device-handoff.json")
        : undefined;
    if (handoffPath !== undefined) await mkdir(dirname(handoffPath), { recursive: true });
    const client = new Auth0CliManagementClient({
      executablePath: executable,
      ...(handoffPath !== undefined
        ? {
            openDeviceUrl: (url: URL) => {
              writeFileSync(
                handoffPath,
                `${JSON.stringify({
                  schemaVersion: 1,
                  event: "auth0_device_url",
                  url: url.href,
                  createdAt: new Date().toISOString(),
                  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
                })}\n`,
                { encoding: "utf8", mode: 0o600, flag: "wx" },
              );
            },
          }
        : options.deviceUrlStdout === true
          ? {
              openDeviceUrl: (url: URL) => {
                process.stdout.write(
                  `${JSON.stringify({ event: "auth0_device_url", url: url.href })}\n`,
                );
              },
            }
          : {}),
    });
    try {
      await client.login(tenant, auth0ManagementScopes);
      const tenants = await client.listTenants();
      emit(
        {
          ok: true,
          requestedTenant: tenant === undefined ? null : normalizeIssuer(tenant),
          tenants,
          credentialStorage: "official-auth0-cli-windows-keyring",
          executable,
        },
        options.json === true,
        "Auth0 login completed; the refresh credential remains in the Windows keyring.",
      );
    } finally {
      if (handoffPath !== undefined) await unlink(handoffPath).catch(() => undefined);
    }
  });

auth
  .command("setup")
  .description("Idempotently provision the dedicated Auth0 API and strict DCR policy")
  .option("--tenant <origin>", "Auth0 tenant origin; defaults to the configured issuer")
  .option("--auth0-cli <path>", "existing official Auth0 CLI executable")
  .option(
    "--audience <url>",
    "HTTPS API audience to provision; defaults to the configured audience without changing it",
  )
  .option("--json", "emit machine-readable JSON")
  .action(async (options: AuthSetupOptions) => {
    const config = await loadOmniCodexConfig();
    const token = process.env.OMNICODEX_AUTH0_MANAGEMENT_TOKEN;
    delete process.env.OMNICODEX_AUTH0_MANAGEMENT_TOKEN;
    const tenant = options.tenant ?? config.auth.issuer;
    const baseAudience = options.audience ?? config.auth.audience;
    const provisioner =
      token === undefined || token.length === 0
        ? new Auth0ManagementProvisioner({
            requester: new Auth0CliManagementClient({
              executablePath: await new Auth0CliInstaller({
                dataDirectory: omniCodexDataDirectory(),
              }).ensure(options.auth0Cli),
            }),
          })
        : new Auth0ManagementProvisioner({ managementToken: token });
    const audiences = [
      baseAudience,
      new URL(config.gateway.fullPath, new URL(baseAudience).origin).href,
    ];
    const results = [];
    for (const audience of [...new Set(audiences)]) {
      results.push(
        await provisioner.provision({
          tenantOrigin: tenant,
          audience,
          scope: config.auth.requiredScopes[0] ?? "omnicodex:full",
          apiName: audience === baseAudience ? "OmniCodex" : "OmniCodex Full",
        }),
      );
    }
    emit(
      { ok: true, auth: results },
      options.json === true,
      `Auth0 is ready for ${results.map((result) => result.audience).join(", ")} with strict DCR and owner-gated access.`,
    );
  });

auth
  .command("dcr-clients")
  .description("List bounded third-party DCR cleanup candidates without secrets")
  .option("--tenant <origin>", "Auth0 tenant origin; defaults to the configured issuer")
  .option("--auth0-cli <path>", "existing official Auth0 CLI executable")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: AuthDcrOptions) => {
    const config = await loadOmniCodexConfig();
    const tenant = normalizeIssuer(options.tenant ?? config.auth.issuer);
    const janitor = await auth0DcrClientJanitor(options.auth0Cli);
    const clients = await janitor.list(tenant);
    const candidates = clients.filter((client) => client.likelyDisposableDcrClient);
    emit(
      {
        ok: true,
        tenant,
        candidateCount: candidates.length,
        protectedClientCount: clients.length - candidates.length,
        candidates,
      },
      options.json === true,
      `Found ${candidates.length} bounded third-party DCR cleanup candidate(s); no client was changed.`,
    );
  });

auth
  .command("cleanup-dcr")
  .description("Delete one reviewed third-party DCR client after exact fingerprint readback")
  .requiredOption("--client-id <id>", "exact Auth0 client id from auth dcr-clients")
  .requiredOption("--fingerprint <sha256>", "exact public-metadata fingerprint")
  .option("--tenant <origin>", "Auth0 tenant origin; defaults to the configured issuer")
  .option("--auth0-cli <path>", "existing official Auth0 CLI executable")
  .option("--execute", "delete the exact reviewed client")
  .option("--non-interactive", "fail instead of prompting")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: AuthDcrCleanupOptions) => {
    const config = await loadOmniCodexConfig();
    const tenant = normalizeIssuer(options.tenant ?? config.auth.issuer);
    const janitor = await auth0DcrClientJanitor(options.auth0Cli);
    let client: Auth0DcrClientSummary;
    if (options.execute === true) {
      client = await janitor.deleteExact(tenant, options.clientId, options.fingerprint);
    } else {
      const candidate = (await janitor.list(tenant)).find(
        (candidate) =>
          candidate.clientId === options.clientId &&
          candidate.fingerprint === options.fingerprint &&
          candidate.likelyDisposableDcrClient,
      );
      if (candidate === undefined) {
        throw new Error("Exact reviewed DCR cleanup candidate was not found");
      }
      client = candidate;
    }
    emit(
      { ok: true, executed: options.execute === true, tenant, client },
      options.json === true,
      options.execute === true
        ? `Deleted exact reviewed DCR client ${client.clientId}.`
        : `DCR cleanup dry-run passed for ${client.clientId}; use --execute to delete it.`,
    );
  });

auth
  .command("rotate")
  .description("Rotate the stored Auth0 management credential reference")
  .requiredOption("--credential-ref <reference>", "new Credential Manager/DPAPI reference")
  .option("--execute", "persist the rotation")
  .option("--non-interactive", "fail instead of prompting")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: RotateOptions) => {
    await requireStoppedDaemon();
    const config = await loadOmniCodexConfig();
    const authConfig = {
      ...config.auth,
      managementCredentialRef: options.credentialRef,
      ...(config.auth.managementCredentialRef === undefined
        ? {}
        : { previousManagementCredentialRef: config.auth.managementCredentialRef }),
    };
    if (options.execute === true) await saveOmniCodexConfig({ ...config, auth: authConfig });
    emit(
      { ok: true, executed: options.execute === true, auth: authConfig },
      options.json === true,
      options.execute === true
        ? "Auth credential reference rotated."
        : "Auth rotation dry-run complete.",
    );
  });

auth
  .command("migrate-fam")
  .description("Import FAM metadata without deleting or disabling the source resource")
  .requiredOption("--input <path>", "non-secret exported FAM metadata JSON")
  .option("--execute", "persist imported issuer/audience/resource and credential reference")
  .option("--non-interactive", "fail instead of prompting")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: MigrationOptions) => {
    await requireStoppedDaemon();
    const source: unknown = JSON.parse(await readFile(resolve(options.input), "utf8"));
    if (
      !isObject(source) ||
      typeof source.issuer !== "string" ||
      typeof source.audience !== "string" ||
      typeof source.resource !== "string" ||
      typeof source.credentialRef !== "string"
    )
      throw new Error(
        "FAM import must contain non-secret issuer, audience, resource, and credentialRef",
      );
    const config = await loadOmniCodexConfig();
    const imported: OmniCodexConfig = {
      ...config,
      auth: {
        ...config.auth,
        issuer: source.issuer,
        audience: source.audience,
        resource: source.resource,
        managementCredentialRef: source.credentialRef,
      },
    };
    if (options.execute === true) await saveOmniCodexConfig(imported);
    emit(
      { ok: true, executed: options.execute === true, sourceChanged: false, config: imported },
      options.json === true,
      options.execute === true
        ? "FAM metadata imported; source unchanged."
        : "FAM migration dry-run complete; source unchanged.",
    );
  });

program
  .command("update")
  .description("Install, verify, drain, and atomically activate one exact npm release")
  .requiredOption("--target-version <semver>", "exact OmniCodex npm version")
  .requiredOption("--expected-commit <sha>", "exact lowercase GitHub source commit")
  .option(
    "--drain-timeout <milliseconds>",
    "caller-selected active-call drain deadline",
    parsePositiveInteger,
  )
  .option("--execute", "perform the staged release transition")
  .option("--non-interactive", "fail instead of prompting")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: ReleaseUpdateOptions) => {
    if (options.execute !== true) {
      const launcher = await ensureStableReleaseLauncher();
      emit(
        {
          ok: true,
          operation: "update",
          executed: false,
          requestedVersion: options.targetVersion,
          expectedCommit: validateExpectedCommit(options.expectedCommit),
          active: launcher.active,
          gates: releaseGateNames,
        },
        options.json === true,
        `Update dry-run prepared for ${options.targetVersion}; use --execute to stage and switch.`,
      );
      return;
    }
    await withDaemonLifecycleLock(async () => {
      const result = await (
        await createReleaseController(
          options.drainTimeout,
          validateExpectedCommit(options.expectedCommit),
        )
      ).update(options.targetVersion);
      emit(
        { ok: true, executed: true, ...result },
        options.json === true,
        `OmniCodex ${result.active.version} activated after shadow validation and drain.`,
      );
    });
  });

program
  .command("rollback")
  .description("Drain and atomically restore one retained healthy release plus state snapshot")
  .option(
    "--target-version <semver>",
    "exact retained version; defaults to the newest prior release",
  )
  .option(
    "--drain-timeout <milliseconds>",
    "caller-selected active-call drain deadline",
    parsePositiveInteger,
  )
  .option("--execute", "perform the rollback")
  .option("--non-interactive", "fail instead of prompting")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: ReleaseRollbackOptions) => {
    if (options.execute !== true) {
      const launcher = await ensureStableReleaseLauncher();
      const retained = await new LocalReleasePointer().retainedHealthy();
      emit(
        {
          ok: true,
          operation: "rollback",
          executed: false,
          requestedVersion: options.targetVersion ?? null,
          active: launcher.active,
          retained,
        },
        options.json === true,
        "Rollback dry-run complete; use --execute to drain and restore.",
      );
      return;
    }
    await withDaemonLifecycleLock(async () => {
      const result = await (await createReleaseController(options.drainTimeout)).rollback(
        options.targetVersion,
      );
      emit(
        { ok: true, executed: true, ...result },
        options.json === true,
        `OmniCodex rolled back to ${result.active.version}.`,
      );
    });
  });

acceptance
  .command("record")
  .description("Hash and atomically record one actual same-build acceptance receipt")
  .requiredOption("--gate <name>", "exact release acceptance gate")
  .requiredOption("--source-commit <sha>", "exact lowercase source commit")
  .requiredOption("--package-version <semver>", "exact packed package version")
  .requiredOption("--package-sha256 <digest>", "exact packed package SHA-256")
  .requiredOption("--artifact <kind=absolute-path...>", "one or more actual result artifacts")
  .option("--evidence <absolute-path>", "release acceptance evidence JSON")
  .option("--execute", "persist the immutable gate receipt")
  .option("--non-interactive", "fail instead of prompting")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: AcceptanceRecordOptions) => {
    const evidencePath = resolve(
      options.evidence ?? join(omniCodexDataDirectory(), "evidence", "release-acceptance.json"),
    );
    const store = new ReleaseAcceptanceStore(evidencePath);
    const input = {
      gate: options.gate,
      sourceCommit: validateExpectedCommit(options.sourceCommit),
      packageVersion: validateExpectedVersion(options.packageVersion),
      packageSha256: validateExpectedSha256(options.packageSha256),
      artifacts: options.artifact.map(parseAcceptanceArtifact),
    };
    const evidence =
      options.execute === true ? await store.record(input) : await store.preview(input);
    emit(
      { ok: true, executed: options.execute === true, evidencePath, gate: options.gate, evidence },
      options.json === true,
      options.execute === true
        ? `Recorded immutable actual evidence for ${options.gate}.`
        : `Acceptance record dry-run complete for ${options.gate}; use --execute to persist.`,
    );
  });

acceptance
  .command("status")
  .description("List every missing or invalid candidate/final release gate without inference")
  .option("--evidence <absolute-path>", "release acceptance evidence JSON")
  .option(
    "--stage <candidate|released>",
    "candidate or final public-release contract",
    parseAcceptanceStage,
    "candidate",
  )
  .option("--expected-commit <sha>", "exact source commit")
  .option("--expected-package-version <semver>", "exact package version")
  .option("--expected-package-sha256 <digest>", "exact packed artifact digest")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: AcceptanceOptions) => {
    const { evidencePath, evidence } = await readAcceptanceEvidence(options.evidence);
    const result = evaluateOmniCodexAcceptance(evidence, {
      stage: options.stage,
      ...(options.expectedCommit === undefined
        ? {}
        : { sourceCommit: validateExpectedCommit(options.expectedCommit) }),
      ...(options.expectedPackageVersion === undefined
        ? {}
        : { packageVersion: validateExpectedVersion(options.expectedPackageVersion) }),
      ...(options.expectedPackageSha256 === undefined
        ? {}
        : { packageSha256: validateExpectedSha256(options.expectedPackageSha256) }),
    });
    emit(
      { ok: true, evidencePath, evidencePresent: evidence !== undefined, ...result },
      options.json === true,
      result.ready
        ? `OmniCodex ${result.stage} acceptance is verified for one exact build.`
        : `OmniCodex ${result.stage} acceptance is incomplete.`,
    );
  });

acceptance
  .command("verify")
  .description("Fail closed unless every required actual gate belongs to one exact build")
  .option("--evidence <absolute-path>", "release acceptance evidence JSON")
  .option(
    "--stage <candidate|released>",
    "candidate or final public-release contract",
    parseAcceptanceStage,
    "candidate",
  )
  .option("--expected-commit <sha>", "exact source commit")
  .option("--expected-package-version <semver>", "exact package version")
  .option("--expected-package-sha256 <digest>", "exact packed artifact digest")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: AcceptanceOptions) => {
    const { evidencePath, evidence } = await readAcceptanceEvidence(options.evidence);
    const result = evaluateOmniCodexAcceptance(evidence, {
      stage: options.stage,
      ...(options.expectedCommit === undefined
        ? {}
        : { sourceCommit: validateExpectedCommit(options.expectedCommit) }),
      ...(options.expectedPackageVersion === undefined
        ? {}
        : { packageVersion: validateExpectedVersion(options.expectedPackageVersion) }),
      ...(options.expectedPackageSha256 === undefined
        ? {}
        : { packageSha256: validateExpectedSha256(options.expectedPackageSha256) }),
    });
    if (!result.ready) {
      const failed = result.gates
        .filter((gate) => !gate.passed)
        .map((gate) => `${gate.name}:${gate.reason ?? "failed"}`)
        .join(",");
      throw new Error(`OmniCodex ${result.stage} acceptance is incomplete (${failed})`);
    }
    emit(
      { ok: true, evidencePath, evidencePresent: true, ...result },
      options.json === true,
      `OmniCodex ${result.stage} acceptance is verified for one exact build.`,
    );
  });

auth
  .command("status")
  .description("Check configured authorization-server discovery without a management token")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const config = await loadOmniCodexConfig();
    if (
      config.companionOnly === true ||
      config.auth.issuer.length === 0 ||
      config.auth.audience.length === 0
    ) {
      emit(
        {
          ok: false,
          configured: false,
          companionOnly: config.companionOnly === true,
          issuer: config.auth.issuer,
          audience: config.auth.audience,
          scope: config.auth.requiredScopes,
          ownerSubjects: config.auth.allowedSubjects.length,
          discoveryStatus: null,
          issuerMatches: false,
          dynamicRegistrationAdvertised: false,
        },
        options.json === true,
        "OmniCodex authorization is not configured.",
      );
      return;
    }
    const discoveryUrl = new URL("/.well-known/openid-configuration", config.auth.issuer);
    const response = await fetch(discoveryUrl, {
      redirect: "manual",
    });
    const body = await response.text();
    let metadata: unknown;
    try {
      metadata = JSON.parse(body);
    } catch {
      metadata = undefined;
    }
    const issuerMatches =
      isObject(metadata) &&
      typeof metadata.issuer === "string" &&
      normalizeIssuer(metadata.issuer) === normalizeIssuer(config.auth.issuer);
    const result = {
      ok: response.status === 200 && issuerMatches,
      issuer: config.auth.issuer,
      audience: config.auth.audience,
      scope: config.auth.requiredScopes,
      ownerSubjects: config.auth.allowedSubjects.length,
      discoveryStatus: response.status,
      issuerMatches,
      dynamicRegistrationAdvertised:
        isObject(metadata) && typeof metadata.registration_endpoint === "string",
    };
    emit(
      result,
      options.json === true,
      result.ok
        ? "OmniCodex authorization-server discovery is valid."
        : "OmniCodex authorization-server discovery is not ready.",
    );
  });

const tunnel = program.command("tunnel").description("Configure the owned outbound HTTPS tunnel");
const tunnelSet = tunnel.command("set").description("Select an outbound tunnel adapter");

tunnelSet
  .command("ngrok")
  .description("Use a stable reserved ngrok HTTPS origin")
  .requiredOption("--url <origin>", "reserved HTTPS origin, for example https://owner.ngrok.app")
  .option("--executable <path>", "ngrok executable path")
  .option("--credential-ref <reference>", "existing CurrentUser DPAPI credential reference")
  .option("--authtoken-stdin", "read the ngrok authtoken from stdin and protect it with DPAPI")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: NgrokTunnelOptions) => {
    await requireStoppedDaemon();
    if (options.credentialRef !== undefined && options.authtokenStdin === true)
      throw new Error("Use either --credential-ref or --authtoken-stdin, not both");
    if (options.credentialRef === undefined && options.authtokenStdin !== true)
      throw new Error("ngrok requires --authtoken-stdin or --credential-ref");
    const config = await loadOmniCodexConfig();
    const executablePath = await resolveNgrokExecutable(options.executable);
    const secretStore = new WindowsDpapiSecretStore({
      directory: join(omniCodexDataDirectory(), "secrets"),
    });
    let createdReference: string | undefined;
    let credentialRef = options.credentialRef;
    if (options.authtokenStdin === true) {
      createdReference = await secretStore.put("ngrok-authtoken", await readSecretFromStdin());
      credentialRef = createdReference;
    }
    if (credentialRef === undefined) throw new Error("ngrok credential reference is unavailable");
    const tunnelConfig = {
      kind: "ngrok" as const,
      executablePath,
      publicUrl: options.url,
      credentialRef,
    };
    const updated: OmniCodexConfig = {
      ...config,
      tunnel: tunnelConfig,
    };
    try {
      await saveOmniCodexConfig(updated);
      const readback = await loadOmniCodexConfig();
      if (readback.tunnel?.kind !== "ngrok" || readback.tunnel.credentialRef !== credentialRef)
        throw new Error("ngrok configuration authoritative readback failed");
    } catch (error) {
      if (createdReference !== undefined)
        await secretStore.remove(createdReference).catch(() => undefined);
      throw error;
    }
    const previousReference =
      config.tunnel?.kind === "ngrok" ? config.tunnel.credentialRef : undefined;
    if (
      createdReference !== undefined &&
      previousReference?.startsWith("dpapi:v1:") === true &&
      previousReference !== createdReference
    )
      await secretStore.remove(previousReference);
    emit(
      { ok: true, tunnel: updated.tunnel, configPath: omniCodexConfigPath() },
      options.json === true,
      `Configured ngrok tunnel at ${tunnelConfig.publicUrl}.`,
    );
  });

for (const kind of ["cloudflare", "tailscale"] as const) {
  tunnelSet
    .command(kind)
    .description(`Use a stable ${kind} HTTPS ingress`)
    .requiredOption("--url <origin>", "stable public HTTPS origin")
    .requiredOption("--executable <path>", `${kind} executable path`)
    .option("--credential-ref <reference>", "Credential Manager/DPAPI reference")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: ExternalTunnelOptions) => {
      await requireStoppedDaemon();
      const config = await loadOmniCodexConfig();
      const updated: OmniCodexConfig = {
        ...config,
        tunnel: {
          kind,
          executablePath: resolve(options.executable),
          publicUrl: options.url,
          ...(options.credentialRef === undefined ? {} : { credentialRef: options.credentialRef }),
        },
      };
      await saveOmniCodexConfig(updated);
      emit({ ok: true, tunnel: updated.tunnel }, options.json === true, `Configured ${kind}.`);
    });
}

tunnelSet
  .command("oracle-ssh")
  .description("Use the dedicated Oracle fixed-IP HTTPS ingress over an owned reverse SSH backhaul")
  .requiredOption("--url <origin>", "fixed public HTTPS origin")
  .requiredOption("--executable <path>", "absolute OpenSSH client path")
  .requiredOption("--host <host>", "Oracle SSH host or IP")
  .option("--port <port>", "Oracle SSH port", parseTcpPort, 22)
  .requiredOption("--user <user>", "dedicated non-privileged Oracle backhaul user")
  .requiredOption("--identity-file <path>", "dedicated private key path")
  .option("--remote-port <port>", "Oracle loopback ingress port", parseTcpPort, 18766)
  .option("--json", "emit machine-readable JSON")
  .action(async (options: OracleSshTunnelOptions) => {
    await requireStoppedDaemon();
    const config = await loadOmniCodexConfig();
    const resource = new URL(config.gateway.fullPath, new URL(options.url)).href;
    const updated: OmniCodexConfig = {
      ...config,
      auth: {
        ...config.auth,
        audience: resource,
        resource,
      },
      tunnel: {
        kind: "oracle_ssh",
        executablePath: resolve(options.executable),
        publicUrl: options.url,
        sshHost: options.host,
        sshPort: options.port,
        sshUser: options.user,
        identityFile: resolve(options.identityFile),
        remotePort: options.remotePort,
      },
      ...(config.oracle === undefined
        ? {}
        : { oracle: transitionOracleResource(config.oracle, resource) }),
    };
    await saveOmniCodexConfig(updated);
    const readback = await loadOmniCodexConfig();
    if (
      readback.tunnel?.kind !== "oracle_ssh" ||
      readback.auth.audience !== resource ||
      readback.auth.resource !== resource ||
      (readback.oracle !== undefined && readback.oracle.resource !== resource)
    ) {
      throw new Error("Oracle SSH configuration authoritative readback failed");
    }
    emit(
      { ok: true, tunnel: readback.tunnel },
      options.json === true,
      `Configured Oracle SSH backhaul at ${readback.tunnel.publicUrl}.`,
    );
  });

tunnelSet
  .command("direct")
  .description("Use an externally managed stable HTTPS ingress")
  .requiredOption("--url <origin>", "stable public HTTPS origin")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: DirectTunnelOptions) => {
    await requireStoppedDaemon();
    const config = await loadOmniCodexConfig();
    const updated: OmniCodexConfig = {
      ...config,
      tunnel: { kind: "direct", publicUrl: options.url },
    };
    await saveOmniCodexConfig(updated);
    emit({ ok: true, tunnel: updated.tunnel }, options.json === true, "Configured direct ingress.");
  });

tunnel
  .command("disable")
  .description("Disable remote tunneling without changing local MCP configuration")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    await requireStoppedDaemon();
    const config = await loadOmniCodexConfig();
    const { tunnel: _removed, ...withoutTunnel } = config;
    await saveOmniCodexConfig(withoutTunnel);
    emit(
      { ok: true, tunnel: null, configPath: omniCodexConfigPath() },
      options.json === true,
      "OmniCodex remote tunnel is disabled.",
    );
  });

tunnel
  .command("status")
  .description("Show configured and running tunnel state")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const [config, state] = await Promise.all([loadOmniCodexConfig(), readOmniCodexDaemonState()]);
    const result = {
      configured: config.tunnel ?? null,
      running: state?.tunnel ?? null,
    };
    emit(
      result,
      options.json === true,
      config.tunnel === undefined
        ? "OmniCodex remote tunnel is disabled."
        : `${config.tunnel.kind} is configured for ${config.tunnel.publicUrl}.`,
    );
  });

if (isDirectCliInvocation()) await program.parseAsync(process.argv);

interface JsonOptions {
  readonly json?: boolean;
}

interface DaemonTransitionOptions extends JsonOptions {
  readonly drainTimeout?: number;
  readonly force?: boolean;
}

interface InitOptions extends JsonOptions {
  readonly issuer?: string;
  readonly audience?: string;
  readonly resource?: string;
  readonly subject?: string[];
  readonly scope: string[];
  readonly jwksUri?: string;
  readonly root: string;
  readonly port: number;
  readonly allowedOrigin: string[];
  readonly localOnly?: boolean;
  readonly nonInteractive?: boolean;
  readonly execute?: boolean;
}

interface CompleteInitOptions extends Omit<InitOptions, "issuer" | "audience" | "subject"> {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string[];
}

interface NgrokTunnelOptions extends JsonOptions {
  readonly url: string;
  readonly executable?: string;
  readonly credentialRef?: string;
  readonly authtokenStdin?: boolean;
}

interface AuthSetupOptions extends JsonOptions {
  readonly tenant?: string;
  readonly auth0Cli?: string;
  readonly audience?: string;
}

interface AuthLoginOptions extends JsonOptions {
  readonly tenant?: string;
  readonly auth0Cli?: string;
  readonly deviceUrlStdout?: boolean;
  readonly deviceUrlHandoff?: boolean;
}
interface AuthDcrOptions extends JsonOptions {
  readonly tenant?: string;
  readonly auth0Cli?: string;
}
interface AuthDcrCleanupOptions extends AuthDcrOptions {
  readonly clientId: string;
  readonly fingerprint: string;
  readonly execute?: boolean;
  readonly nonInteractive?: boolean;
}

interface ExternalTunnelOptions extends JsonOptions {
  readonly url: string;
  readonly executable: string;
  readonly credentialRef?: string;
}

interface OracleSshTunnelOptions extends JsonOptions {
  readonly url: string;
  readonly executable: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly remotePort: number;
}

interface DirectTunnelOptions extends JsonOptions {
  readonly url: string;
}
interface RotateOptions extends JsonOptions {
  readonly credentialRef: string;
  readonly execute?: boolean;
  readonly nonInteractive?: boolean;
}
interface MigrationOptions extends JsonOptions {
  readonly input: string;
  readonly execute?: boolean;
  readonly nonInteractive?: boolean;
}
interface ReleaseUpdateOptions extends JsonOptions {
  readonly targetVersion: string;
  readonly expectedCommit: string;
  readonly drainTimeout?: number;
  readonly execute?: boolean;
  readonly nonInteractive?: boolean;
}
interface ReleaseRollbackOptions extends JsonOptions {
  readonly targetVersion?: string;
  readonly drainTimeout?: number;
  readonly execute?: boolean;
  readonly nonInteractive?: boolean;
}
interface AcceptanceOptions extends JsonOptions {
  readonly evidence?: string;
  readonly stage: OmniCodexAcceptanceStage;
  readonly expectedCommit?: string;
  readonly expectedPackageVersion?: string;
  readonly expectedPackageSha256?: string;
}
interface AcceptanceRecordOptions extends JsonOptions {
  readonly gate: string;
  readonly sourceCommit: string;
  readonly packageVersion: string;
  readonly packageSha256: string;
  readonly artifact: string[];
  readonly evidence?: string;
  readonly execute?: boolean;
  readonly nonInteractive?: boolean;
}

async function completeInitOptions(options: InitOptions): Promise<CompleteInitOptions> {
  let issuer = options.issuer;
  let audience = options.audience;
  let subject = options.subject;
  if (
    (issuer === undefined || audience === undefined || subject === undefined) &&
    process.stdin.isTTY
  ) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      issuer ??= (await prompt.question("Auth0/OIDC issuer URL: ")).trim();
      audience ??= (await prompt.question("OmniCodex API audience: ")).trim();
      subject ??= [(await prompt.question("Owner subject (sub): ")).trim()];
    } finally {
      prompt.close();
    }
  }
  if (issuer === undefined || issuer.length === 0) throw new Error("--issuer is required");
  if (audience === undefined || audience.length === 0) throw new Error("--audience is required");
  if (subject === undefined || subject.length === 0) throw new Error("--subject is required");
  return { ...options, issuer, audience, subject };
}

async function readSecretFromStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("--authtoken-stdin requires piped stdin");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 64 * 1024) throw new Error("Secret input exceeded 64 KiB");
    chunks.push(bytes);
  }
  const secret = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (secret.length < 16 || /[\r\n\0]/.test(secret))
    throw new Error("Secret input is empty, weak, or multiline");
  return secret;
}

async function launchDaemon(
  daemonPath = resolve(dirname(fileURLToPath(import.meta.url)), "daemon.js"),
  releasePath = resolve(dirname(daemonPath), ".."),
  initialAdmission: "open" | "draining" = "open",
): Promise<OmniCodexDaemonState> {
  // Keep this immediately before process creation so every direct and release
  // activation persists the legacy-config migration before a daemon can open
  // integrity-protected state.
  await ensureInternalIntegrityKeysInitialized();
  const instanceNonce = randomBytes(32).toString("base64url");
  const daemonLogDirectory = join(omniCodexDataDirectory(), "logs");
  await mkdir(daemonLogDirectory, { recursive: true });
  const daemonStderrPath = join(daemonLogDirectory, "daemon-stderr.log");
  writeFileSync(
    daemonStderrPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event: "daemon_spawn", releasePath })}\n`,
    { encoding: "utf8", flag: "a", mode: 0o600 },
  );
  const daemonStderr = openSync(daemonStderrPath, "a", 0o600);
  let child: OwnedHiddenChildProcess;
  try {
    child = spawnHidden(process.execPath, [daemonPath], {
      detached: true,
      // Native OOM/abort diagnostics are emitted on stderr and used to vanish
      // behind `ignore`. A file descriptor stays fully hidden on Windows while
      // preserving the evidence needed for autonomous recovery.
      stdio: ["ignore", "ignore", daemonStderr],
      env: {
        ...process.env,
        OMNICODEX_DAEMON: "1",
        OMNICODEX_DAEMON_INSTANCE_NONCE: instanceNonce,
        OMNICODEX_RELEASE_PATH: releasePath,
        OMNICODEX_INITIAL_ADMISSION: initialAdmission,
      },
    });
  } finally {
    closeSync(daemonStderr);
  }
  if (child.pid === undefined) {
    terminateOwnedHiddenChild(child);
    throw new Error("OmniCodex daemon did not receive a process id");
  }
  child.unref();
  try {
    const state = await waitForDaemon(child, instanceNonce);
    if (state.lifecycle === "failed") throw new Error(state.error ?? "OmniCodex daemon failed");
    return state;
  } catch (error) {
    terminateOwnedHiddenChild(child);
    throw error;
  }
}

async function launchThroughScheduledTaskWhenEnabled(): Promise<OmniCodexDaemonState | undefined> {
  if (process.platform !== "win32") return undefined;
  if (process.env.OMNICODEX_AUTOSTART_SOURCE !== undefined) {
    const existing = await readOmniCodexDaemonState();
    if (existing === undefined || !(await daemonOwnershipIsLive(existing))) return undefined;
    if (existing.lifecycle === "failed") {
      throw new Error(existing.error ?? "OmniCodex daemon failed and is still exiting");
    }
    return existing;
  }
  // Both launcher layers are OmniCodex-owned generated artifacts. Refresh the
  // stable JS launcher, then refresh only the VBS bytes after proving that its
  // existing Task/Run registration still targets the owned launcher path.
  // This lets system Node and the Codex-bundled Node alternate safely without
  // mutating the Scheduled Task definition or its enabled state.
  await ensureStableReleaseLauncher();
  const manager = autostartManager();
  await manager.refreshOwnedLauncher();
  const status: WindowsAutostartStatus = await manager.status();
  if (status.enabled && status.mechanism !== "scheduled-task") {
    throw new Error(
      "OmniCodex legacy autostart must be migrated before an independent daemon launch",
    );
  }
  if (!status.enabled) {
    if (status.mechanism !== null) {
      throw new Error(
        "OmniCodex autostart is installed but disabled; re-enable the exact Scheduled Task before launch",
      );
    }
    return undefined;
  }
  const existing = await readOmniCodexDaemonState();
  if (existing !== undefined && (await daemonOwnershipIsLive(existing))) {
    const settled =
      existing.lifecycle === "ready" ? existing : await waitForExistingDaemon(existing);
    if (settled.lifecycle === "failed") {
      throw new Error(settled.error ?? "OmniCodex daemon failed during startup");
    }
    return settled;
  }
  // The scheduled task launches an independent CLI process. Commit and verify
  // the DPAPI-backed bootstrap before triggering it, rather than relying on the
  // later child to repair a legacy config after activation has already begun.
  await withDaemonLifecycleLock(ensureInternalIntegrityKeysInitialized, {
    waitOnContention: true,
  });
  let observedLaunch = await manager.lastLaunch();
  const invokedAt = Date.now();
  const deadline = invokedAt + 180_000;
  let launchRequested = false;
  while (Date.now() <= deadline) {
    const state = await readOmniCodexDaemonState();
    if (
      state !== undefined &&
      (state.lifecycle === "ready" ||
        (state.lifecycle === "failed" && state.startedAtUnixMs >= invokedAt))
    ) {
      if (state.lifecycle === "failed") {
        throw new Error(state.error ?? "Scheduled OmniCodex daemon failed");
      }
      // An independent scheduled launch can publish its starting state while
      // bootstrap preparation holds the lifecycle lock, before invokedAt is
      // recorded. Adopt its ready state by verified process ownership, just as
      // the initial adoption above does. Restart still verifies the exact
      // selected release before reporting success.
      if (await daemonOwnershipIsLive(state)) return state;
    }
    const settledLaunch = await manager.lastLaunch();
    const launchReceiptChanged =
      settledLaunch !== undefined && !sameAutostartLaunchReceipt(observedLaunch, settledLaunch);
    if (
      launchReceiptChanged &&
      Date.parse(settledLaunch.startedAt) >= invokedAt &&
      settledLaunch.source === "scheduled-task" &&
      settledLaunch.event === "autostart_failed"
    ) {
      throw new Error(
        `Scheduled OmniCodex start exited before publishing a ready daemon (exit ${String(settledLaunch.exitCode ?? "unknown")})`,
      );
    }
    if (
      launchReceiptChanged &&
      launchRequested &&
      Date.parse(settledLaunch.startedAt) < invokedAt
    ) {
      // Task Scheduler's IgnoreNew policy can acknowledge Run while the
      // previous supervisor is in its final settlement window. Its late
      // receipt proves that the acknowledged request did not create the new
      // independent launcher, so make exactly the normal zero-instance launch
      // path eligible again instead of waiting for the watchdog or timing out.
      launchRequested = false;
    }
    if (launchReceiptChanged) observedLaunch = settledLaunch;
    // Once Run is acknowledged, durable state/receipt polling is sufficient.
    // Do not spawn a Task Scheduler query process on every readiness poll.
    if (!launchRequested && (await manager.runningInstanceCount()) === 0) {
      await manager.launch();
      launchRequested = true;
    }
    await delay(250);
  }
  const starting = await readOmniCodexDaemonState();
  if (starting?.lifecycle === "starting" && (await daemonOwnershipIsLive(starting))) {
    // A verified scheduled daemon can need longer than the launch-receipt window
    // to initialize. Keep its exact identity and wait for readiness or failure.
    const settled = await waitForExistingDaemon(starting, 420_000);
    if (settled.lifecycle === "failed") {
      throw new Error(settled.error ?? "Scheduled OmniCodex daemon failed during startup");
    }
    return settled;
  }
  throw new Error("Timed out waiting for scheduled OmniCodex daemon state or launch receipt");
}

function sameAutostartLaunchReceipt(
  left: WindowsAutostartStatus["lastLaunch"],
  right: WindowsAutostartStatus["lastLaunch"],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.timestamp === right.timestamp &&
    left.startedAt === right.startedAt &&
    left.event === right.event &&
    left.exitCode === right.exitCode
  );
}

async function waitForDaemon(
  child: OwnedHiddenChildProcess,
  instanceNonce: string,
  timeoutMs?: number,
): Promise<OmniCodexDaemonState> {
  const pid = child.pid;
  if (pid === undefined) throw new Error("OmniCodex daemon did not receive a process id");
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readOmniCodexDaemonState();
    if (
      state?.pid === pid &&
      state.instanceNonce === instanceNonce &&
      (state.lifecycle === "ready" || state.lifecycle === "failed") &&
      (state.lifecycle === "failed" || (await daemonOwnershipIsLive(state)))
    ) {
      return state;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("OmniCodex daemon exited during startup");
    }
    await delay(250);
  }
  throw new Error("OmniCodex daemon startup timed out");
}

async function waitForExistingDaemon(
  expected: OmniCodexDaemonState,
  timeoutMs?: number,
): Promise<OmniCodexDaemonState> {
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readOmniCodexDaemonState();
    if (
      state === undefined ||
      state.pid !== expected.pid ||
      state.instanceNonce !== expected.instanceNonce ||
      state.startedAtUnixMs !== expected.startedAtUnixMs
    ) {
      throw new Error("OmniCodex daemon identity changed while startup was settling");
    }
    if (state.lifecycle === "failed") return state;
    if (state.lifecycle === "ready" && (await daemonOwnershipIsLive(state))) return state;
    if (!(await daemonOwnershipIsLive(state))) {
      throw new Error("OmniCodex daemon exited while startup was settling");
    }
    await delay(250);
  }
  throw new Error("OmniCodex daemon startup timed out");
}

async function superviseScheduledTaskDaemon(state: OmniCodexDaemonState): Promise<void> {
  if (process.env.OMNICODEX_AUTOSTART_SOURCE !== "scheduled-task") return;
  await ensureConfiguredOmniCodex2Tunnel();
  // The exact PID/start-time/nonce ownership check has already passed before
  // reaching this boundary. Waiting on that process (with no internal
  // deadline) makes the scheduled action the long-lived supervisor while still
  // allowing the authenticated stop/restart paths to end it normally.
  await waitForExactDaemonProcessExit(state);
  const terminal = [...(await new OmniCodexOperationalLog().read())]
    .reverse()
    .find(
      (entry) =>
        entry.pid === state.pid &&
        Date.parse(entry.timestamp) >= state.startedAtUnixMs &&
        (entry.event === "daemon_stopped" || entry.event === "daemon_failed"),
    );
  if (terminal?.event === "daemon_stopped") return;
  if (terminal?.event === "daemon_failed") {
    const detail = typeof terminal.details?.error === "string" ? `: ${terminal.details.error}` : "";
    throw new Error(`Scheduled OmniCodex daemon failed${detail}`);
  }
  // A later Scheduled Task run may recover service availability, but the
  // failed generation must not be recorded as a successful autostart.
  throw new Error("Scheduled OmniCodex daemon exited without a terminal lifecycle receipt");
}

export async function ensureConfiguredOmniCodex2Tunnel(): Promise<void> {
  const appData = process.env.APPDATA;
  if (appData === undefined || appData.length === 0) return;
  const log = new OmniCodexOperationalLog();
  try {
    let profileDirectory = join(appData, "tunnel-client");
    try {
      await access(join(profileDirectory, "omnicodex2.yaml"));
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData === undefined || localAppData.length === 0) return;
      // Codex's MSIX AppData view can contain the existing profile while the
      // unpackaged scheduled task sees an empty roaming directory.
      profileDirectory = join(
        localAppData,
        "Packages",
        "OpenAI.Codex_2p2nqsd0c76g0",
        "LocalCache",
        "Roaming",
        "tunnel-client",
      );
      try {
        await access(join(profileDirectory, "omnicodex2.yaml"));
      } catch (profileError) {
        if (isObject(profileError) && profileError.code === "ENOENT") return;
        throw profileError;
      }
    }
    const powershellExecutable = join(
      process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawnHidden(
      powershellExecutable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(CLI_PROJECT_ROOT, "scripts", "windows", "start-omnicodex2-tunnel.ps1"),
        "-ProfileDirectory",
        profileDirectory,
        "-EnsureRunning",
      ],
      {
        cwd: CLI_PROJECT_ROOT,
        env: { ...process.env, OMNICODEX_DATA_DIR: omniCodexDataDirectory() },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    await new Promise<void>((resolveStart, rejectStart) => {
      child.once("error", rejectStart);
      child.once("close", (code, signal) => {
        if (code === 0) resolveStart();
        else {
          rejectStart(
            new Error(
              `omnicodex2 tunnel startup failed (exit ${code}, signal ${signal}): ${stderr.trim()}`,
            ),
          );
        }
      });
    });
  } catch (error) {
    await log
      .append("external_tunnel_start_failed", {
        alias: "omnicodex2",
        source: "scheduled-task",
        error: toError(error).message,
      })
      .catch((logError: unknown) => {
        process.stderr.write(`${toError(error).message}\n${toError(logError).message}\n`);
      });
  }
}

interface DaemonControlResponse {
  readonly ok: true;
  readonly pid: number;
  readonly instanceNonce: string;
  readonly startedAtUnixMs: number;
  readonly lifecycle: OmniCodexDaemonState["lifecycle"];
  readonly runtime?: {
    readonly admission?: "open" | "draining";
    readonly activeMcpRequests?: number;
    readonly runtimePath?: string;
    readonly catalogBaseline?: OmniCodexFullCatalogSnapshot;
    readonly actionCatalog?: OracleClientBindingsActionCatalogAutoRefreshResult;
    readonly active?: OmniCodexThreadInventorySnapshot["active"];
    readonly archived?: OmniCodexThreadInventorySnapshot["archived"];
    readonly canonicalBridgeThreadId?: string;
    readonly oracle?: OracleDaemonRuntimeStatus;
    readonly goalObservation?: {
      readonly conversationUrl: string;
      readonly outcome: string;
      readonly observedGoals: readonly string[];
    };
    readonly desktopChatEvents?: DesktopChatEventObservationStatus;
  };
}

type DaemonControlCommand =
  | "refresh-action-catalog"
  | "status"
  | "stop"
  | "begin-drain"
  | "await-drained"
  | "resume-admission"
  | "switch-runtime"
  | "catalog-baseline"
  | "thread-inventory"
  | "desktop-chat-events"
  | "observe-goal-conversation"
  | "oracle-runtime-status";

export function requestGoalConversationObservation(
  state: OmniCodexDaemonState,
  clientBinding: string,
  conversationUrl: string,
  signal?: AbortSignal,
): Promise<DaemonControlResponse> {
  return requestDaemonControl(
    state,
    "observe-goal-conversation",
    undefined,
    undefined,
    signal,
    clientBinding,
    conversationUrl,
  );
}

/** Operator refreshes select one registration within the daemon-owned flight and cooldown. */
export async function requestOracleActionCatalogSync(
  state: OmniCodexDaemonState,
  clientBinding: string,
  signal?: AbortSignal,
): Promise<OracleActionCatalogAutoRefreshResult> {
  const response = await requestDaemonControl(
    state,
    "refresh-action-catalog",
    undefined,
    undefined,
    signal,
    clientBinding,
  );
  const actionCatalog = response.runtime?.actionCatalog;
  const result = actionCatalog?.bindings[clientBinding];
  if (result === undefined && actionCatalog !== undefined) {
    const { bindings: _bindings, ...state } = actionCatalog;
    return state;
  }
  if (result === undefined) throw new Error(`ORACLE_CATALOG_BINDING_NOT_READY:${clientBinding}`);
  return result;
}

async function readDaemonCatalogBaseline(
  state: OmniCodexDaemonState,
): Promise<LiveLocalCatalogBaseline> {
  const response = await requestDaemonControl(state, "catalog-baseline");
  const runtime = response.runtime;
  if (runtime?.catalogBaseline === undefined) {
    throw new Error("LIVE_LOCAL_CATALOG_BASELINE_UNAVAILABLE");
  }
  return { daemonPid: response.pid, ...runtime.catalogBaseline };
}

export async function readDaemonThreadInventory(
  state: OmniCodexDaemonState,
): Promise<OmniCodexThreadInventorySnapshot> {
  const response = await requestDaemonControl(state, "thread-inventory");
  const runtime = response.runtime;
  if (
    !Array.isArray(runtime?.active) ||
    !Array.isArray(runtime.archived) ||
    typeof runtime.canonicalBridgeThreadId !== "string" ||
    runtime.canonicalBridgeThreadId.length === 0
  ) {
    throw new Error("LIVE_LOCAL_THREAD_INVENTORY_UNAVAILABLE");
  }
  return {
    active: runtime.active,
    archived: runtime.archived,
    canonicalBridgeThreadId: runtime.canonicalBridgeThreadId,
  };
}

export interface DaemonStatusObservation {
  /** Null means ownership/liveness could not be verified, not that the daemon stopped. */
  readonly running: boolean | null;
  readonly processStatus: ProcessStatus | "not_recorded";
  readonly controlStatus: "reachable" | "unreachable" | "not_checked";
  readonly lifecycle: OmniCodexDaemonState["lifecycle"] | "stopped" | "unresponsive" | "unknown";
  readonly stale: boolean;
  readonly reason?:
    | "no_state"
    | "previous_boot"
    | "process_absent"
    | "process_alive"
    | "process_unknown";
  readonly controlError?: string;
}

/** Read-only status reporting; lifecycle mutation authority still uses daemonOwnershipIsLive. */
export async function observeDaemonStatus(
  state: OmniCodexDaemonState | undefined,
  options: {
    readonly probeProcess?: (pid: number) => ProcessStatus;
    readonly readControl?: (
      state: OmniCodexDaemonState,
    ) => Promise<{ readonly lifecycle: OmniCodexDaemonState["lifecycle"] }>;
  } = {},
): Promise<DaemonStatusObservation> {
  if (state === undefined) {
    return {
      running: false,
      processStatus: "not_recorded",
      controlStatus: "not_checked",
      lifecycle: "stopped",
      stale: false,
      reason: "no_state",
    };
  }
  const processStatus = (options.probeProcess ?? probeProcessStatus)(state.pid);
  if (processStatus === "absent") {
    return {
      running: false,
      processStatus,
      controlStatus: "not_checked",
      lifecycle: "stopped",
      stale: true,
      reason: "process_absent",
    };
  }
  try {
    const control = await (
      options.readControl ??
      ((current) =>
        // Bound this diagnostic read only. Work and lifecycle mutation deadlines
        // remain caller-controlled, and a timed-out observation is inconclusive.
        requestDaemonControl(current, "status", undefined, undefined, AbortSignal.timeout(10_000)))
    )(state);
    return {
      running: true,
      processStatus,
      controlStatus: "reachable",
      lifecycle: control.lifecycle,
      stale: false,
    };
  } catch (error) {
    const assessment = assessUnreachableDaemonState(state, { processStatus });
    const stale = assessment.status === "definitely_stale";
    return {
      running: stale ? false : null,
      processStatus,
      controlStatus: "unreachable",
      lifecycle: stale ? "stopped" : processStatus === "alive" ? "unresponsive" : "unknown",
      stale,
      reason: assessment.reason,
      controlError: toError(error).message,
    };
  }
}

export function daemonStatusMessage(observation: DaemonStatusObservation, pid?: number): string {
  if (observation.running === true) return `OmniCodex ${observation.lifecycle} (pid ${pid})`;
  if (observation.running === false) return "OmniCodex is stopped.";
  const process = observation.processStatus === "alive" ? "exists" : "could not be verified";
  return `OmniCodex process ${pid} ${process}, but its authenticated control channel is unreachable: ${observation.controlError ?? "unknown error"}`;
}

async function daemonOwnershipIsLive(state: OmniCodexDaemonState): Promise<boolean> {
  // A stale Windows named-pipe path can leave connect() waiting even after its
  // owner has exited. Prove the recorded PID still exists before opening the
  // authenticated control channel so status/start/restart recover immediately
  // from an exited daemon without disturbing any unrelated process.
  if (probeProcessStatus(state.pid) === "absent") return false;
  return requestDaemonControl(state, "status").then(
    () => true,
    () => false,
  );
}

async function waitForDaemonControlClose(
  state: OmniCodexDaemonState,
  timeoutMs?: number,
): Promise<void> {
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  let consecutiveClosedChecks = 0;
  while (Date.now() < deadline) {
    if (await daemonOwnershipIsLive(state)) consecutiveClosedChecks = 0;
    else consecutiveClosedChecks += 1;
    if (consecutiveClosedChecks >= 3) return;
    await delay(200);
  }
  throw new Error("OmniCodex did not close its authenticated control channel before the deadline");
}

async function waitForExactDaemonProcessExit(
  state: OmniCodexDaemonState,
  timeoutMs?: number,
): Promise<void> {
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
  while (true) {
    const processStatus = probeProcessStatus(state.pid);
    if (processStatus === "absent") return;
    if (Date.now() >= deadline) {
      throw new Error(
        `OmniCodex daemon process ${state.pid} did not exit after its authenticated control channel closed`,
      );
    }
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

function requestDaemonControl(
  state: OmniCodexDaemonState,
  command: DaemonControlCommand,
  drainTimeoutMs?: number,
  targetRuntimePath?: string,
  signal?: AbortSignal,
  clientBinding?: string,
  conversationUrl?: string,
): Promise<DaemonControlResponse> {
  signal?.throwIfAborted();
  return new Promise((resolveControl, rejectControl) => {
    const socket = connect(state.controlPipe);
    socket.setEncoding("utf8");
    let input = "";
    let settled = false;
    const finish = (error: Error | undefined, response?: DaemonControlResponse): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (error !== undefined) rejectControl(error);
      else if (response !== undefined) resolveControl(response);
      else rejectControl(new Error("OmniCodex control response was empty"));
    };
    // A caller deadline ends this observation, not another subscriber's shared refresh.
    const onAbort = () =>
      finish(
        signal?.reason instanceof Error ? signal.reason : new Error("Control observation aborted"),
      );
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (error) => finish(error));
    socket.once("end", () =>
      finish(new Error("OmniCodex control channel closed before returning a response")),
    );
    socket.once("close", () =>
      finish(new Error("OmniCodex control channel closed before returning a response")),
    );
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          command,
          token: state.controlToken,
          expectedPid: state.pid,
          expectedInstanceNonce: state.instanceNonce,
          expectedStartedAtUnixMs: state.startedAtUnixMs,
          ...(drainTimeoutMs === undefined ? {} : { timeoutMs: drainTimeoutMs }),
          ...(targetRuntimePath === undefined ? {} : { targetRuntimePath }),
          ...(clientBinding === undefined ? {} : { clientBinding }),
          ...(conversationUrl === undefined ? {} : { conversationUrl }),
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.slice(0, newline));
      } catch {
        finish(new Error("OmniCodex control response was not valid JSON"));
        return;
      }
      if (
        !isObject(parsed) ||
        parsed.pid !== state.pid ||
        parsed.instanceNonce !== state.instanceNonce ||
        parsed.startedAtUnixMs !== state.startedAtUnixMs ||
        !isDaemonLifecycle(parsed.lifecycle)
      ) {
        finish(new Error("OmniCodex control ownership proof was rejected"));
        return;
      }
      if (parsed.ok !== true) {
        finish(
          new Error(
            typeof parsed.error === "string" && parsed.error.length > 0
              ? parsed.error
              : "OmniCodex control request was rejected",
          ),
        );
        return;
      }
      finish(undefined, parsed as unknown as DaemonControlResponse);
    });
  });
}

async function drainAndStopOwnedDaemon(
  state: OmniCodexDaemonState,
  drainTimeoutMs?: number,
): Promise<void> {
  try {
    // The authenticated stop handler closes admission synchronously and then
    // drains every already accepted request. Asking an older daemon to wait
    // for every Web conversation to become globally idle can never converge
    // while independent long-running tasks legitimately overlap.
    await requestDaemonControl(state, "stop", drainTimeoutMs);
  } catch (error) {
    // Older daemons could begin their authenticated stop before the success
    // bytes reached the CLI. Continue only when that exact owned PID really
    // exits; a live or replaced process still fails the restart.
    if (
      !(error instanceof Error) ||
      error.message !== "OmniCodex control channel closed before returning a response"
    ) {
      throw error;
    }
    try {
      await waitForExactDaemonProcessExit(state, Math.min(drainTimeoutMs ?? 30_000, 30_000));
    } catch {
      throw error;
    }
  }
}

async function stopStartingOwnedDaemonBeforeLifecycleLock(): Promise<void> {
  const state = await readOmniCodexDaemonState();
  if (state === undefined || state.lifecycle !== "starting") return;

  // The authenticated control request is fenced by the exact PID, instance
  // nonce, start time, pipe, and token from the durable state. It asks the
  // daemon to cancel its own preparation and clean only resources it owns;
  // this path never signals an unverified process.
  await requestDaemonControl(state, "stop");
  await waitForDaemonControlClose(state);
  const stopped = await readOmniCodexDaemonState();
  if (stopped === undefined || !sameDaemonProcess(state, stopped)) {
    throw new Error("Daemon state changed during authenticated startup cancellation");
  }
  await waitForExactDaemonProcessExit(stopped);
}

async function configExists(): Promise<boolean> {
  try {
    await loadOmniCodexConfig();
    return true;
  } catch {
    return false;
  }
}

function normalizeIssuer(value: string): string {
  return `${value.replace(/\/+$/, "")}/`;
}

async function readAcceptanceEvidence(
  requestedPath?: string,
): Promise<{ readonly evidencePath: string; readonly evidence: unknown | undefined }> {
  const evidencePath = resolve(
    requestedPath ?? join(omniCodexDataDirectory(), "evidence", "release-acceptance.json"),
  );
  try {
    return { evidencePath, evidence: JSON.parse(await readFile(evidencePath, "utf8")) };
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return { evidencePath, evidence: undefined };
    throw error;
  }
}

function parseAcceptanceStage(value: string): OmniCodexAcceptanceStage {
  if (value === "candidate" || value === "released") return value;
  throw new Error("Acceptance stage must be candidate or released");
}

function validateExpectedCommit(value: string): string {
  if (!/^[a-f0-9]{40}$/.test(value))
    throw new Error("Expected commit must be exact lowercase SHA-1");
  return value;
}

function validateExpectedVersion(value: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("Expected package version must be exact semver");
  }
  return value;
}

function validateExpectedSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Expected package SHA-256 is invalid");
  return value;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be 0-65535");
  }
  return port;
}

function parseTcpPort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("TCP port must be 1-65535");
  }
  return port;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Value must be a positive safe integer");
  }
  return parsed;
}

function parseOracleTestTimeout(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Oracle test timeout must be a positive safe integer");
  }
  return parsed;
}

function parseRuntimeDrainTimeout(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Runtime drain timeout must be a positive safe integer");
  }
  return parsed;
}

export function parseRuntimeCallTimeout(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > NODE_MAX_TIMER_DELAY_MS) {
    throw new Error(`Runtime call timeout must be 1-${NODE_MAX_TIMER_DELAY_MS} milliseconds`);
  }
  return parsed;
}

export function runtimeCallRequestOptions(timeout: number | undefined): {
  readonly timeout: number;
  readonly resetTimeoutOnProgress: true;
  readonly maxTotalTimeout?: number;
} {
  return {
    // The MCP client otherwise injects a hidden 60-second deadline. Node requires
    // a finite timer value, so its maximum delay is used only as an idle watchdog;
    // it is not a product deadline and progress keeps a live request alive.
    timeout: timeout ?? NODE_MAX_TIMER_DELAY_MS,
    resetTimeoutOnProgress: true,
    ...(timeout === undefined ? {} : { maxTotalTimeout: timeout }),
  };
}

export async function closeRuntimeCallSession(
  client: Pick<Client, "close">,
  transport: Pick<StreamableHTTPClientTransport, "terminateSession">,
  connected: boolean,
): Promise<void> {
  let terminationError: unknown;
  if (connected) {
    try {
      // Client.close() only closes the local transport. DELETE is the MCP
      // lifecycle boundary that retires transport-scoped Browser Use state.
      await transport.terminateSession();
    } catch (error) {
      terminationError = error;
    }
  }
  try {
    await client.close();
  } catch (error) {
    terminationError ??= error;
  }
  if (terminationError !== undefined) throw terminationError;
}

export function transitionOracleResource(
  oracle: OmniCodexOracleConfig,
  resource: string,
): OmniCodexOracleConfig {
  if (oracle.resource === resource) return oracle;
  const {
    lastStateVerification: _lastStateVerification,
    lastActionCatalogVerification: _lastActionCatalogVerification,
    pendingConnectAttempt: _pendingConnectAttempt,
    lastReceipts: _lastReceipts,
    ...stable
  } = oracle;
  return { ...stable, resource, freshLiveVerification: "pending" };
}

export function parseRuntimeToolArguments(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Runtime tool arguments must be valid JSON", { cause: error });
  }
  if (!isObject(parsed)) throw new Error("Runtime tool arguments must be a JSON object");
  return parsed;
}

function formatHttpHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function autostartManager(): WindowsAutostartManager {
  return new WindowsAutostartManager(autostartManagerOptions());
}

async function ensureInternalIntegrityKeysInitialized(): Promise<void> {
  assertGatewayConfigured(await loadOmniCodexConfig());
  const keys = await ensureOmniCodexInternalIntegrityKeys();
  keys.dispose();
}

function autostartManagerOptions() {
  return {
    nodeExecutable: process.execPath,
    launcherScript: new StableReleaseLauncher().launcherPath,
  };
}

async function ensureStableReleaseLauncher(activateCurrent = false) {
  const cliScript = fileURLToPath(import.meta.url);
  const packageJsonPath = resolve(dirname(cliScript), "..", "package.json");
  const packageJson: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (!isObject(packageJson) || typeof packageJson.version !== "string") {
    throw new Error("Installed OmniCodex package version is unavailable");
  }
  return new StableReleaseLauncher().ensureBootstrap(cliScript, packageJson.version, {
    activateCurrent,
  });
}

async function createReleaseController(
  drainTimeoutMs?: number,
  expectedSourceCommit?: string,
): Promise<ReleaseTransitionController> {
  if (
    drainTimeoutMs !== undefined &&
    (!Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs <= 0)
  ) {
    throw new Error("Release drain timeout must be a positive safe integer when supplied");
  }
  // Run before release state snapshots are captured. Otherwise rolling back a
  // legacy snapshot could discard the only reference to the key protecting
  // durable schedules and event sessions.
  await ensureInternalIntegrityKeysInitialized();
  await ensureStableReleaseLauncher();
  const initialState = await readOmniCodexDaemonState();
  if (initialState === undefined || !(await daemonOwnershipIsLive(initialState))) {
    throw new Error("Start the owned OmniCodex daemon before a live release transition");
  }
  let controlledState = initialState;
  const dataDirectory = omniCodexDataDirectory();
  const launcher = new StableReleaseLauncher({ dataDirectory });
  const snapshots = new LocalReleaseStateSnapshots(dataDirectory);
  const pointer = new LocalReleasePointer({
    dataDirectory,
    launcher,
    deactivate: stopOwnedDaemonForReleaseSwitch,
    restoreState: async (snapshotId) => snapshots.restore(snapshotId),
    activate: async (active) => {
      const ready = await launchDaemon(active.daemonScript, active.releasePath, "draining");
      if (
        ready.lifecycle !== "ready" ||
        ready.releasePath === undefined ||
        resolve(ready.releasePath) !== resolve(active.releasePath)
      ) {
        throw new Error("Activated daemon did not prove the selected release identity");
      }
      controlledState = ready;
    },
  });
  const drain = new CallbackReleaseAdmissionDrain({
    begin: async () => {
      // Preserve Web turns across the release transition, including thinking
      // gaps where no finite MCP request is currently in flight.
      const response = await requestDaemonControl(controlledState, "begin-drain", drainTimeoutMs);
      if (response.runtime?.admission !== "draining") {
        throw new Error("Daemon did not enter draining admission state");
      }
    },
    awaitDrained: async () => {
      const response = await requestDaemonControl(controlledState, "await-drained", drainTimeoutMs);
      if (response.runtime?.activeMcpRequests !== 0) {
        throw new Error("Daemon reported active requests after drain completion");
      }
    },
    resume: async () => {
      const current = await requireLiveDaemonState();
      controlledState = current;
      const response = await requestDaemonControl(current, "resume-admission");
      if (response.runtime?.admission !== "open") {
        throw new Error("Daemon did not reopen MCP admission");
      }
    },
  });
  return new ReleaseTransitionController({
    source: new NpmReleaseSource({
      npmCliScript: await resolveNpmCliScript(),
      dataDirectory,
      ...(expectedSourceCommit === undefined ? {} : { expectedSourceCommit }),
    }),
    validator: new NpmReleaseValidator({ dataDirectory }),
    snapshots,
    drain,
    pointer,
    observation: new CallbackReleaseObservation(async (releasePath) => {
      const state = await requireLiveDaemonState();
      controlledState = state;
      if (state.releasePath === undefined || resolve(state.releasePath) !== resolve(releasePath)) {
        throw new Error("Observed daemon release identity did not match the active pointer");
      }
      if (state.address === undefined)
        throw new Error("Observed daemon omitted its gateway address");
      const origin = `http://${state.address.host}:${state.address.port}`;
      const [metadata, unauthorized] = await Promise.all([
        fetch(`${origin}/.well-known/oauth-protected-resource${state.address.fullPath}`),
        fetch(`${origin}${state.address.fullPath}`, {
          headers: { Accept: "text/event-stream" },
        }),
      ]);
      if (metadata.status !== 200 || unauthorized.status !== 401) {
        throw new Error("Activated daemon failed protected MCP observation");
      }
    }),
  });
}

async function stopOwnedDaemonForReleaseSwitch(): Promise<void> {
  const state = await readOmniCodexDaemonState();
  if (state === undefined) return;
  if (await daemonOwnershipIsLive(state)) {
    await requestDaemonControl(state, "stop");
    await waitForDaemonControlClose(state);
    return;
  }
  if (state.lifecycle === "failed") return;
  const assessment = assessUnreachableDaemonState(state);
  if (assessment.status === "definitely_stale") return;
  throw new Error("Daemon ownership became ambiguous during release activation");
}

async function requireLiveDaemonState(): Promise<OmniCodexDaemonState> {
  const state = await readOmniCodexDaemonState();
  if (state === undefined || !(await daemonOwnershipIsLive(state))) {
    throw new Error("Activated OmniCodex daemon ownership could not be verified");
  }
  return state;
}

async function resolveNpmCliScript(): Promise<string> {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (!absolute.replaceAll("\\", "/").endsWith("/npm/bin/npm-cli.js")) continue;
    try {
      await access(absolute);
      return absolute;
    } catch {
      // Continue through fixed npm installation candidates.
    }
  }
  throw new Error("The npm CLI script could not be resolved without a command shell");
}

async function auth0DcrClientJanitor(auth0Cli?: string): Promise<Auth0DcrClientJanitor> {
  const executable = await new Auth0CliInstaller({
    dataDirectory: omniCodexDataDirectory(),
  }).ensure(auth0Cli);
  return new Auth0DcrClientJanitor({
    requester: new Auth0CliManagementClient({ executablePath: executable }),
  });
}

export interface FunctionsExecProbeResult {
  readonly nativeCapabilities: readonly {
    readonly capability: string;
    readonly name: string;
  }[];
  readonly directCalls: readonly {
    readonly capability: string;
    readonly name: string;
  }[];
  readonly sessionParity: {
    readonly activeCount: number;
    readonly archivedCount: number;
    readonly totalCount: number;
    readonly uniqueCount: number;
    readonly readThreadCount: number;
    readonly turnPageCount: number;
    readonly turnCount: number;
    readonly threadsWithMoreTurns: number;
    readonly threadIds: readonly string[];
    readonly threadKinds: readonly string[];
    readonly kindParity: readonly {
      readonly kind: string;
      readonly activeCount: number;
      readonly archivedCount: number;
      readonly totalCount: number;
      readonly readThreadCount: number;
      readonly representativeThreadId: string;
    }[];
    readonly representativeReads: readonly {
      readonly kind: string;
      readonly threadId: string;
      readonly archived: boolean;
      readonly hostId: string | null;
      readonly turnCount: number;
      readonly hasMoreTurns: boolean;
    }[];
  };
}

function assertFullNativeCatalog(
  tools: readonly Tool[],
  pageToolCounts: readonly number[],
  local: OmniCodexFullCatalogSnapshot,
): {
  readonly criticalToolName: "codex__functions__exec";
  readonly codeModeToolName: "codex__functions__exec";
  readonly toolCount: number;
  readonly publicActionToolCount: number;
  readonly pageToolCounts: readonly number[];
  readonly inputSchemaSha256: string;
  readonly descriptionSha256: string;
} {
  if (tools.length === 0 || new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error("Installed runtime advertised an empty or duplicate ChatGPT action catalog");
  }
  if (
    !/^[a-f0-9]{64}$/.test(local.catalogRevision) ||
    pageToolCounts.length === 0 ||
    pageToolCounts.some((count) => !Number.isInteger(count) || count < 1) ||
    pageToolCounts.reduce((sum, count) => sum + count, 0) !== tools.length
  ) {
    throw new Error("Installed runtime advertised an invalid ChatGPT action-catalog page sequence");
  }

  if (
    tools.some((tool) => {
      const metadata =
        isObject(tool._meta) && isObject(tool._meta.omnicodex) ? tool._meta.omnicodex : undefined;
      return (
        metadata === undefined ||
        typeof metadata.nativeName !== "string" ||
        typeof metadata.route !== "string" ||
        !["none", "model", "unknown"].includes(String(metadata.modelEffect)) ||
        !["none", "read", "mutate"].includes(String(metadata.stateEffect)) ||
        metadata.catalogRevision !== local.catalogRevision
      );
    })
  ) {
    throw new Error("Installed runtime omitted the public native execution metadata contract");
  }
  const presentNames = new Set(tools.map((tool) => tool.name));
  const priorityNames = OMNICODEX_FULL_CATALOG_PRIORITY.filter((name) => presentNames.has(name));
  if (
    tools.slice(0, priorityNames.length).some((tool, index) => tool.name !== priorityNames[index])
  ) {
    throw new Error("Installed runtime did not prioritize the direct-work ChatGPT action catalog");
  }

  // The production `/mcp/full` transport presents ChatGPT's bounded eager
  // action snapshot. The daemon-owned local snapshot remains the lossless full
  // registry, and `call_native_tool` executes entries whose exact installed
  // descriptors do not fit the platform registration budget. Do not mistake
  // that deliberate transport split for a missing native capability.
  assertRequiredDirectWorkToolCatalog(tools);
  const router = tools.find((tool) => tool.name === "call_native_tool");
  if (router === undefined) {
    throw new Error("Installed runtime omitted the lossless native execution router");
  }
  const routerProperties = isObject(router.inputSchema.properties)
    ? Object.keys(router.inputSchema.properties).sort((left, right) =>
        left.localeCompare(right, "en"),
      )
    : [];
  const routerRequired = Array.isArray(router.inputSchema.required)
    ? router.inputSchema.required
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => left.localeCompare(right, "en"))
    : [];
  const routerDescriptionSha256 = semanticDigest(router.description ?? "");
  const routerInputSchemaSha256 = semanticDigest(router.inputSchema);
  if (
    local.chatGptCriticalToolName !== "call_native_tool" ||
    local.chatGptCriticalToolProperties !== routerProperties.join(",") ||
    local.chatGptCriticalToolRequired !== routerRequired.join(",") ||
    local.chatGptCriticalToolDescriptionSha256 !== routerDescriptionSha256 ||
    local.chatGptCriticalToolInputSchemaSha256 !== routerInputSchemaSha256
  ) {
    throw new Error("Live local ChatGPT action readback does not match the public router");
  }

  if (
    typeof local.criticalToolInputSchemaSha256 !== "string" ||
    local.criticalToolInputSchemaSha256 !== semanticDigest(FUNCTIONS_EXEC_INPUT_SCHEMA)
  ) {
    throw new Error("Installed runtime advertised an unexpected functions.exec input schema");
  }
  if (
    typeof local.criticalToolDescriptionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(local.criticalToolDescriptionSha256)
  ) {
    throw new Error("Installed runtime omitted the critical direct-execution description");
  }
  if (local.criticalToolProperties !== "input" || local.criticalToolRequired !== "input") {
    throw new Error("Installed runtime omitted the functions.exec freeform input contract");
  }
  const inputSchemaSha256 = local.criticalToolInputSchemaSha256;
  const descriptionSha256 = local.criticalToolDescriptionSha256;
  const catalogToolNames = tools
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right, "en"));
  if (
    !local.catalogToolNames.includes("codex__functions__exec") ||
    local.catalogToolCount !== local.catalogToolNames.length ||
    local.catalogPageToolCounts.reduce((sum, count) => sum + count, 0) !== local.catalogToolCount ||
    local.catalogToolNamesSha256 !== semanticDigest(local.catalogToolNames) ||
    local.chatGptActionToolCount !== tools.length ||
    canonicalJson(local.chatGptActionToolNames) !== canonicalJson(catalogToolNames) ||
    local.chatGptActionToolNamesSha256 !== semanticDigest(catalogToolNames)
  ) {
    throw new Error(
      "Live local full-registry or ChatGPT action readback does not match the public catalog",
    );
  }
  return {
    criticalToolName: "codex__functions__exec",
    codeModeToolName: "codex__functions__exec",
    toolCount: local.catalogToolCount,
    publicActionToolCount: tools.length,
    pageToolCounts: [...pageToolCounts],
    inputSchemaSha256,
    descriptionSha256,
  };
}

async function listCompleteToolCatalog(
  client: Client,
): Promise<{ readonly tools: Tool[]; readonly pageToolCounts: number[] }> {
  const tools: Tool[] = [];
  const pageToolCounts: number[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    if (page.tools.length === 0) {
      throw new Error("Installed runtime returned an empty full-catalog page");
    }
    tools.push(...page.tools);
    pageToolCounts.push(page.tools.length);
    const next = page.nextCursor;
    if (next === undefined) break;
    if (page.tools.length === 0 || seenCursors.has(next)) {
      throw new Error("Installed runtime returned an invalid full-catalog cursor sequence");
    }
    seenCursors.add(next);
    cursor = next;
  }
  return { tools, pageToolCounts };
}

interface FunctionsExecRuntimeProbeResult {
  readonly route: "call_native_tool";
  readonly target: "codex__functions__exec";
  readonly nestedToolCount: number;
  readonly nestedRead: "codex_app__list_threads";
  readonly listedThreadCount: number;
}

async function probeFunctionsExec(client: Client): Promise<FunctionsExecRuntimeProbeResult> {
  const input = functionsExecRuntimeProbeInput();
  const result = await client.callTool({
    name: "call_native_tool",
    arguments: {
      name: "codex__functions__exec",
      input,
      // This deadline belongs to the explicit diagnostic operation. Production
      // calls remain unbounded unless their caller supplies one.
      timeoutMs: 60_000,
    },
  });
  if (result.isError === true) {
    throw new Error(
      `Installed runtime functions.exec probe failed: ${compactToolError(result.content)}`,
    );
  }
  if (!Array.isArray(result.content)) {
    throw new Error("Installed runtime functions.exec returned no content blocks");
  }
  const parsed = parseLastJsonText(result.content);
  if (
    !isObject(parsed) ||
    parsed.route !== "call_native_tool" ||
    parsed.target !== "codex__functions__exec" ||
    parsed.nestedRead !== "codex_app__list_threads" ||
    !Number.isSafeInteger(parsed.nestedToolCount) ||
    Number(parsed.nestedToolCount) < 1 ||
    !Number.isSafeInteger(parsed.listedThreadCount) ||
    Number(parsed.listedThreadCount) < 0
  ) {
    throw new Error("Installed runtime functions.exec router probe returned an invalid result");
  }
  return parsed as unknown as FunctionsExecRuntimeProbeResult;
}

function functionsExecRuntimeProbeInput(): string {
  return `
const nestedRead = 'codex_app__list_threads';
const metadataEntries = Array.isArray(ALL_TOOLS) ? ALL_TOOLS : [];
if (metadataEntries.filter((metadata) => metadata?.name === nestedRead).length !== 1) {
  throw new Error('Missing or duplicate nested Codex action: ' + nestedRead);
}
const value = await tools.codex_app__list_threads({limit: 1});
let current = value;
for (let depth = 0; depth < 6; depth += 1) {
  if (current && typeof current === 'object' && (current.isError === true || current.success === false)) {
    throw new Error('codex_app__list_threads failed');
  }
  if (typeof current === 'string') {
    try { current = JSON.parse(current); continue; } catch { break; }
  }
  if (current && typeof current === 'object' && current.structuredContent && typeof current.structuredContent === 'object') {
    current = current.structuredContent;
    continue;
  }
  break;
}
if (!current || typeof current !== 'object' || !Array.isArray(current.pinnedThreads) || !Array.isArray(current.threads)) {
  throw new Error('codex_app__list_threads returned no native inventory');
}
text(JSON.stringify({
  route: 'call_native_tool',
  target: 'codex__functions__exec',
  nestedToolCount: metadataEntries.length,
  nestedRead,
  listedThreadCount: current.pinnedThreads.length + current.threads.length
}));`;
}

export function functionsExecProbeInput(callingThreadId: string | null): string {
  const capabilities = JSON.stringify(FUNCTIONS_EXEC_NESTED_CAPABILITIES);
  return `
const requiredCapabilities = ${capabilities};
const metadataEntries = Array.isArray(ALL_TOOLS) ? ALL_TOOLS : [];
const invalid = requiredCapabilities.filter((entry) => metadataEntries.filter((metadata) => metadata?.name === entry.name).length !== 1);
if (invalid.length > 0) throw new Error('Missing or duplicate nested Codex actions: ' + invalid.map((entry) => entry.name).join(','));
const ensureOk = (value, label) => {
  if (value && typeof value === 'object' && (value.isError === true || value.success === false)) throw new Error(label + ' failed');
  return value;
};
const unwrap = (value, label) => {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    ensureOk(current, label);
    if (typeof current === 'string') {
      try { current = JSON.parse(current); continue; } catch { return current; }
    }
    if (current && typeof current === 'object' && current.structuredContent && typeof current.structuredContent === 'object') {
      current = current.structuredContent;
      continue;
    }
    const blocks = Array.isArray(current)
      ? current
      : current && typeof current === 'object' && Array.isArray(current.contentItems)
        ? current.contentItems
        : current && typeof current === 'object' && Array.isArray(current.content)
          ? current.content
          : undefined;
    if (blocks) {
      const textBlock = [...blocks].reverse().find((block) => block && typeof block === 'object' && typeof block.text === 'string');
      if (textBlock) {
        current = textBlock.text;
        continue;
      }
    }
    return current;
  }
  return current;
};
const active = unwrap(await tools.codex_app__list_threads({limit: 50}), 'list_threads');
const archived = unwrap(await tools.codex_app__list_archived_threads({limit: 50}), 'list_archived_threads');
if (!active || typeof active !== 'object' || !Array.isArray(active.pinnedThreads) || !Array.isArray(active.threads)) throw new Error('No active thread inventory');
if (!Array.isArray(archived?.threads)) throw new Error('No archived thread page');
const activeValues = [...active.pinnedThreads, ...active.threads];
const sessions = [];
for (const [values, isArchived] of [[activeValues, false], [archived.threads, true]]) {
  for (const value of values) {
    if (!value || typeof value !== 'object') throw new Error('Invalid thread inventory entry');
    const kind = typeof value.kind === 'string' ? value.kind.trim() : '';
    if (kind.length === 0) throw new Error('Thread without backing kind');
    if (typeof value.id !== 'string' || value.id.length === 0) throw new Error(kind + ' thread without id');
    const hostId = typeof value.hostId === 'string' && value.hostId.length > 0 ? value.hostId : null;
    sessions.push({id: value.id, kind, hostId, archived: isArchived});
  }
}
const byId = new Map();
for (const session of sessions) {
  if (byId.has(session.id)) throw new Error('Duplicate thread ' + session.id);
  byId.set(session.id, session);
}
if (byId.size === 0) throw new Error('No threads to read');
const callingThreadId = ${JSON.stringify(callingThreadId)};
const threadKinds = [...new Set([...byId.values()].map((session) => session.kind))].sort((left, right) => left.localeCompare(right, 'en'));
const representativeReads = [];
for (const kind of threadKinds) {
  const candidates = [...byId.values()].filter((session) => session.kind === kind);
  const representative = candidates.find((session) => !session.archived && session.id !== callingThreadId)
    ?? candidates.find((session) => !session.archived)
    ?? candidates.find((session) => session.id !== callingThreadId)
    ?? candidates[0];
  if (!representative) throw new Error('No representative ' + kind + ' thread to read');
  const readArgs = {threadId: representative.id, turnLimit: 1, includeOutputs: false};
  if (representative.hostId !== null) readArgs.hostId = representative.hostId;
  const read = unwrap(await tools.codex_app__read_thread(readArgs), 'read_thread:' + kind);
  if (!read?.thread || read.thread.id !== representative.id || read.thread.kind !== kind || !Array.isArray(read.turns)) {
    throw new Error('Wrong or incomplete ' + kind + ' thread readback');
  }
  const page = read.page && typeof read.page === 'object' ? read.page : {};
  if (page.hasMore === true && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0)) throw new Error('Missing ' + kind + ' turn cursor');
  representativeReads.push({
    kind,
    threadId: representative.id,
    archived: representative.archived,
    hostId: representative.hostId,
    turnCount: read.turns.length,
    hasMoreTurns: page.hasMore === true
  });
}
ensureOk(await tools.mcp__node_repl__js({code: "nodeRepl.write({ ok: true, route: 'mcpServer/tool/call' });"}), 'node_repl');
ensureOk(await tools.browser__list_surfaces({}), 'browser_list_surfaces');
const threadIds = [...byId.keys()].sort((left, right) => left.localeCompare(right, 'en'));
const kindParity = threadKinds.map((kind) => {
  const values = [...byId.values()].filter((session) => session.kind === kind);
  const representative = representativeReads.find((read) => read.kind === kind);
  if (!representative) throw new Error('Missing representative read for ' + kind);
  return {
    kind,
    activeCount: values.filter((session) => !session.archived).length,
    archivedCount: values.filter((session) => session.archived).length,
    totalCount: values.length,
    readThreadCount: 1,
    representativeThreadId: representative.threadId
  };
});
text(JSON.stringify({
  nativeCapabilities: requiredCapabilities.map(({capability, name}) => ({capability, name})),
  directCalls: ${JSON.stringify(FUNCTIONS_EXEC_DIRECT_CALLS)},
  sessionParity: {
    activeCount: sessions.filter((session) => !session.archived).length,
    archivedCount: sessions.filter((session) => session.archived).length,
    totalCount: sessions.length,
    uniqueCount: byId.size,
    readThreadCount: representativeReads.length,
    turnPageCount: representativeReads.length,
    turnCount: representativeReads.reduce((sum, read) => sum + read.turnCount, 0),
    threadsWithMoreTurns: representativeReads.filter((read) => read.hasMoreTurns).length,
    threadIds,
    threadKinds,
    kindParity,
    representativeReads
  }
}));`;
}

export function assertFunctionsExecProbeResult(
  parsed: unknown,
): asserts parsed is FunctionsExecProbeResult {
  if (!isObject(parsed)) {
    throw new Error("Installed runtime functions.exec returned no JSON object");
  }
  const nativeCapabilities = parsed.nativeCapabilities;
  const directCalls = parsed.directCalls;
  const sessionParity = parsed.sessionParity;
  if (
    !Array.isArray(nativeCapabilities) ||
    nativeCapabilities.length !== FUNCTIONS_EXEC_NESTED_CAPABILITIES.length ||
    !Array.isArray(directCalls) ||
    directCalls.length !== FUNCTIONS_EXEC_DIRECT_CALLS.length ||
    !isObject(sessionParity) ||
    !Array.isArray(sessionParity.threadIds) ||
    !Array.isArray(sessionParity.threadKinds) ||
    !Array.isArray(sessionParity.kindParity) ||
    !Array.isArray(sessionParity.representativeReads)
  ) {
    throw new Error("Installed runtime functions.exec probe returned an invalid result");
  }
  for (const expected of FUNCTIONS_EXEC_NESTED_CAPABILITIES) {
    if (
      !nativeCapabilities.some(
        (value) =>
          isObject(value) &&
          value.capability === expected.capability &&
          value.name === expected.name,
      )
    ) {
      throw new Error(`Installed runtime omitted nested capability ${expected.capability}`);
    }
  }
  for (const expected of FUNCTIONS_EXEC_DIRECT_CALLS) {
    if (
      !directCalls.some(
        (value) =>
          isObject(value) &&
          value.capability === expected.capability &&
          value.name === expected.name,
      )
    ) {
      throw new Error(`Installed runtime did not complete ${expected.capability} through exec`);
    }
  }
  const numericFields = [
    "activeCount",
    "archivedCount",
    "totalCount",
    "uniqueCount",
    "readThreadCount",
    "turnPageCount",
    "turnCount",
    "threadsWithMoreTurns",
  ] as const;
  if (
    numericFields.some(
      (field) => !Number.isSafeInteger(sessionParity[field]) || Number(sessionParity[field]) < 0,
    ) ||
    Number(sessionParity.totalCount) !==
      Number(sessionParity.activeCount) + Number(sessionParity.archivedCount) ||
    Number(sessionParity.uniqueCount) !== Number(sessionParity.totalCount) ||
    Number(sessionParity.totalCount) === 0 ||
    Number(sessionParity.readThreadCount) !== sessionParity.threadKinds.length ||
    Number(sessionParity.turnPageCount) !== Number(sessionParity.readThreadCount) ||
    sessionParity.threadIds.length !== Number(sessionParity.uniqueCount) ||
    sessionParity.threadIds.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(sessionParity.threadIds).size !== sessionParity.threadIds.length ||
    sessionParity.threadKinds.length === 0 ||
    sessionParity.threadKinds.some((kind) => typeof kind !== "string" || kind.length === 0) ||
    new Set(sessionParity.threadKinds).size !== sessionParity.threadKinds.length ||
    canonicalJson(sessionParity.threadKinds) !==
      canonicalJson(
        [...sessionParity.threadKinds].sort((left, right) =>
          String(left).localeCompare(String(right), "en"),
        ),
      ) ||
    sessionParity.kindParity.length !== sessionParity.threadKinds.length ||
    sessionParity.representativeReads.length !== sessionParity.threadKinds.length
  ) {
    throw new Error("Installed runtime functions.exec returned invalid session parity counts");
  }
  const kindParity = sessionParity.kindParity;
  const representativeReads = sessionParity.representativeReads;
  const parityKinds = kindParity.flatMap((value) =>
    isObject(value) && typeof value.kind === "string" ? [value.kind] : [],
  );
  const readKinds = representativeReads.flatMap((value) =>
    isObject(value) && typeof value.kind === "string" ? [value.kind] : [],
  );
  if (
    parityKinds.length !== kindParity.length ||
    readKinds.length !== representativeReads.length ||
    canonicalJson(parityKinds) !== canonicalJson(sessionParity.threadKinds) ||
    canonicalJson(readKinds) !== canonicalJson(sessionParity.threadKinds)
  ) {
    throw new Error("Installed runtime functions.exec omitted a discovered thread kind read");
  }
  let kindActiveCount = 0;
  let kindArchivedCount = 0;
  let kindTotalCount = 0;
  let readTurnCount = 0;
  let readsWithMoreTurns = 0;
  const representativeThreadIds = new Set<string>();
  for (const value of kindParity) {
    if (!isObject(value)) {
      throw new Error("Installed runtime functions.exec returned invalid kind parity");
    }
    const activeCount = value.activeCount;
    const archivedCount = value.archivedCount;
    const totalCount = value.totalCount;
    if (
      typeof value.kind !== "string" ||
      value.kind.length === 0 ||
      !Number.isSafeInteger(activeCount) ||
      Number(activeCount) < 0 ||
      !Number.isSafeInteger(archivedCount) ||
      Number(archivedCount) < 0 ||
      !Number.isSafeInteger(totalCount) ||
      Number(totalCount) < 1 ||
      Number(totalCount) !== Number(activeCount) + Number(archivedCount) ||
      value.readThreadCount !== 1 ||
      typeof value.representativeThreadId !== "string" ||
      !sessionParity.threadIds.includes(value.representativeThreadId)
    ) {
      throw new Error("Installed runtime functions.exec returned invalid kind parity");
    }
    kindActiveCount += Number(activeCount);
    kindArchivedCount += Number(archivedCount);
    kindTotalCount += Number(totalCount);
    representativeThreadIds.add(value.representativeThreadId);
  }
  for (const value of representativeReads) {
    if (
      !isObject(value) ||
      typeof value.kind !== "string" ||
      typeof value.threadId !== "string" ||
      !sessionParity.threadIds.includes(value.threadId) ||
      typeof value.archived !== "boolean" ||
      !(value.hostId === null || (typeof value.hostId === "string" && value.hostId.length > 0)) ||
      !Number.isSafeInteger(value.turnCount) ||
      Number(value.turnCount) < 0 ||
      typeof value.hasMoreTurns !== "boolean"
    ) {
      throw new Error("Installed runtime functions.exec returned invalid representative read");
    }
    const parity = kindParity.find(
      (candidate) => isObject(candidate) && candidate.kind === value.kind,
    );
    if (!isObject(parity) || parity.representativeThreadId !== value.threadId) {
      throw new Error("Installed runtime functions.exec returned mismatched representative read");
    }
    readTurnCount += Number(value.turnCount);
    if (value.hasMoreTurns) readsWithMoreTurns += 1;
  }
  if (
    representativeThreadIds.size !== sessionParity.threadKinds.length ||
    kindActiveCount !== Number(sessionParity.activeCount) ||
    kindArchivedCount !== Number(sessionParity.archivedCount) ||
    kindTotalCount !== Number(sessionParity.totalCount) ||
    readTurnCount !== Number(sessionParity.turnCount) ||
    readsWithMoreTurns !== Number(sessionParity.threadsWithMoreTurns)
  ) {
    throw new Error("Installed runtime functions.exec returned inconsistent thread kind parity");
  }
}

function parseLastJsonText(content: readonly unknown[]): unknown {
  for (const block of [...content].reverse()) {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") continue;
    try {
      return JSON.parse(block.text.trim());
    } catch {
      // functions.exec may prepend a status text block; continue to the prior block.
    }
  }
  return undefined;
}

function compactToolError(content: unknown): string {
  if (!Array.isArray(content)) return "no content";
  const text = content
    .flatMap((block) =>
      isObject(block) && typeof block.text === "string" ? [block.text.trim()] : [],
    )
    .filter((value) => value.length > 0)
    .join(" | ");
  return text.length === 0 ? "no text error" : text;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function semanticDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function emit(value: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectCliInvocation(): boolean {
  const entryPath = process.argv[1];
  if (entryPath === undefined) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return resolve(entryPath) === modulePath;
  }
}

function publicDaemonState(state: Awaited<ReturnType<typeof readOmniCodexDaemonState>>): unknown {
  if (state === undefined) return undefined;
  const result: Record<string, unknown> = { ...state };
  delete result.controlPipe;
  delete result.controlToken;
  delete result.instanceNonce;
  delete result.tunnelOwnership;
  return result;
}

async function quarantineStaleDaemonAndOwnedChildren(
  state: OmniCodexDaemonState,
): ReturnType<typeof quarantineStaleDaemonState> {
  const processStatus = probeProcessStatus(state.pid);
  const assessment = assessUnreachableDaemonState(state, { processStatus });
  if (assessment.status === "definitely_stale") {
    await reclaimOwnedChildrenOfStaleDaemon(state);
  }
  return quarantineStaleDaemonState(state, { probe: { processStatus } });
}

async function reclaimOwnedChildrenForStoppedDaemon(state: OmniCodexDaemonState): Promise<void> {
  const processStatus = probeProcessStatus(state.pid);
  const assessment = assessUnreachableDaemonState(state, { processStatus });
  if (assessment.status !== "definitely_stale") {
    throw new Error("Stopped daemon ownership is not absent; refusing child-process recovery");
  }
  await reclaimOwnedChildrenOfStaleDaemon(state);
}

async function reclaimOwnedChildrenOfStaleDaemon(state: OmniCodexDaemonState): Promise<void> {
  const log = new OmniCodexOperationalLog();
  if (process.platform === "win32") {
    await log.append("stale_codex_app_servers_reclaim_started", {
      daemonPid: state.pid,
    });
    try {
      const result = await new WindowsStaleCodexAppServerReclaimer({
        dataDirectory: omniCodexDataDirectory(),
      }).reclaim(state);
      await log.append("stale_codex_app_servers_reclaim_completed", {
        daemonPid: state.pid,
        outcome: result.status,
        observedCount: result.observedCount,
        naturallyExitedCount: result.naturallyExitedCount,
        terminatedCount: result.terminatedCount,
      });
    } catch (error) {
      await log
        .append("stale_codex_app_servers_reclaim_refused", {
          daemonPid: state.pid,
          reasonCode: staleOwnedProcessRecoveryReason(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }
  await removeOmniCodexRuntimeWriteEnvironment({
    dataDirectory: omniCodexDataDirectory(),
    instanceId: omniCodexRuntimeInstanceId({
      pid: state.pid,
      startedAtUnixMs: state.startedAtUnixMs,
      instanceNonce: state.instanceNonce,
    }),
  });
  const config = await loadOmniCodexConfig();
  if (
    process.platform === "win32" &&
    config.tunnel?.kind === "ngrok" &&
    (state.tunnel?.kind === "ngrok" || state.tunnelOwnership?.kind === "ngrok")
  ) {
    const tunnelPid = state.tunnelOwnership?.pid ?? state.tunnel?.pid ?? 0;
    await log.append("stale_ngrok_reclaim_started", {
      daemonPid: state.pid,
      tunnelPid,
    });
    try {
      const result = await new WindowsStaleNgrokReclaimer().reclaim({
        daemonState: state,
        executablePath: config.tunnel.executablePath,
        publicUrl: config.tunnel.publicUrl,
      });
      await log.append("stale_ngrok_reclaim_completed", {
        daemonPid: state.pid,
        tunnelPid,
        outcome: result.status,
      });
    } catch (error) {
      await log
        .append("stale_ngrok_reclaim_refused", {
          daemonPid: state.pid,
          tunnelPid,
          reasonCode: staleNgrokRecoveryReason(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }
}

function staleOwnedProcessRecoveryReason(error: unknown): string {
  const message = toError(error).message;
  const code = message.split(":", 1)[0] ?? "UNKNOWN";
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "UNKNOWN";
}

function staleNgrokRecoveryReason(error: unknown): string {
  const message = toError(error).message;
  const code = message.split(":", 1)[0] ?? "UNKNOWN";
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "UNKNOWN";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function requireStoppedDaemon(): Promise<void> {
  const state = await readOmniCodexDaemonState();
  if (state !== undefined && state.lifecycle !== "failed") {
    if (!(await daemonOwnershipIsLive(state))) {
      if (state.lifecycle === "stopping") {
        await reclaimOwnedChildrenForStoppedDaemon(state);
        const retired = await retireStoppedDaemonState(state);
        if (retired.retired) return;
      }
      throw new Error("Daemon ownership is unverifiable; refusing to change tunnel configuration");
    }
    throw new Error("Stop OmniCodex before changing its tunnel configuration");
  }
}

function sameDaemonProcess(left: OmniCodexDaemonState, right: OmniCodexDaemonState): boolean {
  return (
    left.pid === right.pid &&
    left.instanceNonce === right.instanceNonce &&
    left.startedAtUnixMs === right.startedAtUnixMs &&
    left.controlPipe === right.controlPipe &&
    left.controlToken === right.controlToken
  );
}

function isDaemonLifecycle(value: unknown): value is OmniCodexDaemonState["lifecycle"] {
  return (
    value === "starting" ||
    value === "shadow_starting" ||
    value === "draining" ||
    value === "switching" ||
    value === "observing" ||
    value === "retiring_previous" ||
    value === "cleanup_pending" ||
    value === "rolling_back" ||
    value === "ready" ||
    value === "stopping" ||
    value === "failed"
  );
}

async function resolveNgrokExecutable(explicit: string | undefined): Promise<string> {
  return new NgrokInstaller({ dataDirectory: omniCodexDataDirectory() }).ensure(explicit);
}
