#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { access, readFile, rename } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Command } from "commander";
import { OmniCodexGatewayService } from "./application/omnicodex-gateway-service.js";
import { OracleAdapterService } from "./application/oracle-adapter-service.js";
import { Auth0CliInstaller, Auth0CliManagementClient } from "./infrastructure/auth/auth0-cli.js";
import { Auth0ManagementProvisioner } from "./infrastructure/auth/auth0-management-provisioner.js";
import {
  BoundedCdpSession,
  CdpChatGptApprovalSurface,
  type CdpWebSocketLike,
  ChatGptLoopbackCdpTransport,
} from "./infrastructure/chatgpt/chatgpt-cdp-transport.js";
import {
  assertGatewayConfigured,
  loadOmniCodexConfig,
  loadOptionalOmniCodexConfig,
  mergeGatewayInitialization,
  type OmniCodexConfig,
  type OmniCodexDaemonState,
  omniCodexConfigPath,
  omniCodexDataDirectory,
  readOmniCodexDaemonState,
  saveOmniCodexConfig,
} from "./infrastructure/config/omnicodex-config-store.js";
import { OmniCodexOperationalLog } from "./infrastructure/operations/operational-log.js";
import { observeProtectedFile } from "./infrastructure/safety/protected-file-snapshot.js";
import { NgrokInstaller } from "./infrastructure/tunnel/ngrok-installer.js";
import { CodexRuntimeDiscovery } from "./infrastructure/windows/codex-runtime-discovery.js";
import {
  type OwnedHiddenChildProcess,
  spawnHidden,
  terminateOwnedHiddenChild,
} from "./infrastructure/windows/hidden-child-process.js";
import { WindowsAutostartManager } from "./infrastructure/windows/windows-autostart-manager.js";
import { WindowsDpapiSecretStore } from "./infrastructure/windows/windows-dpapi-secret-store.js";

const program = new Command()
  .name("omnicodex")
  .description("Authenticated MCP access to the installed Codex native tool surface")
  .version("0.0.0-development");

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
  .action(async (options: JsonOptions) => {
    assertGatewayConfigured(await loadOmniCodexConfig());
    const existing = await readOmniCodexDaemonState();
    if (existing !== undefined && existing.lifecycle !== "failed") {
      if (await daemonOwnershipIsLive(existing)) {
        emit(
          publicDaemonState(existing),
          options.json === true,
          `OmniCodex is already ${existing.lifecycle} (pid ${existing.pid}).`,
        );
        return;
      }
      throw new Error(
        "Refusing to replace an OmniCodex daemon whose recorded ownership cannot be verified",
      );
    }
    const state = await launchDaemon();
    emit(
      publicDaemonState(state),
      options.json === true,
      `OmniCodex ready at http://${state.address?.host}:${state.address?.port}${state.address?.path}`,
    );
  });

program
  .command("stop")
  .description("Gracefully stop the hidden OmniCodex process and its owned children")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const state = await readOmniCodexDaemonState();
    if (state === undefined) {
      emit({ stopped: true, alreadyStopped: true }, options.json === true, "OmniCodex is stopped.");
      return;
    }
    if (!(await daemonOwnershipIsLive(state))) {
      throw new Error("Refusing to stop a daemon whose ownership cannot be verified");
    }
    await requestDaemonControl(state, "stop");
    await waitForDaemonControlClose(state, 30_000);
    emit({ stopped: true, pid: state.pid }, options.json === true, "OmniCodex stopped.");
  });

program
  .command("restart")
  .description("Gracefully restart the hidden OmniCodex process")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const state = await readOmniCodexDaemonState();
    if (state !== undefined && state.lifecycle !== "failed") {
      if (!(await daemonOwnershipIsLive(state))) {
        throw new Error("Refusing to restart a daemon whose ownership cannot be verified");
      }
      await requestDaemonControl(state, "stop");
      await waitForDaemonControlClose(state, 30_000);
    }
    assertGatewayConfigured(await loadOmniCodexConfig());
    const ready = await launchDaemon();
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
    const running = state !== undefined && (await daemonOwnershipIsLive(state));
    const status = {
      configured: await configExists(),
      running,
      state: state === undefined ? undefined : publicDaemonState(state),
      runtime,
    };
    emit(
      status,
      options.json === true,
      status.running
        ? `OmniCodex ${state?.lifecycle} (pid ${state?.pid})`
        : "OmniCodex is stopped.",
    );
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
    const running = state !== undefined && (await daemonOwnershipIsLive(state));
    const result = {
      ok: configurationError === undefined && runtime.candidates.length > 0,
      config: configurationError === undefined ? "valid" : "missing_or_invalid",
      ...(configurationError === undefined ? {} : { configurationError }),
      runtimeFound: runtime.candidates.length > 0,
      running,
      lifecycle: state?.lifecycle ?? "stopped",
      autostart: autostartState,
    };
    emit(
      result,
      options.json === true,
      result.ok ? "OmniCodex doctor: OK" : "OmniCodex doctor found setup work.",
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
  .command("setup")
  .requiredOption("--connector-id <id>")
  .requiredOption("--connector-name <name>")
  .requiredOption("--run-id <id>")
  .requiredOption("--resource <url>")
  .requiredOption("--surface <path>")
  .requiredOption("--cdp-endpoint <url>")
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
      execute?: boolean;
      json?: boolean;
    }) => {
      if (options.surface !== "/mcp" && options.surface !== "/mcp/full")
        throw new Error("--surface must be /mcp or /mcp/full");
      const result = await new OracleAdapterService().setup(
        { ...options, surface: options.surface },
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
  .option("--json")
  .action(async (options: JsonOptions) => {
    const result = await new OracleAdapterService().status();
    emit(
      result,
      options.json === true,
      result.enabled ? "Oracle adapter is enabled." : "Oracle adapter is disabled.",
    );
  });
oracle
  .command("disable")
  .option("--execute")
  .option("--non-interactive")
  .option("--json")
  .action(async (options: JsonOptions & { execute?: boolean }) => {
    const result = await new OracleAdapterService().disable(options.execute === true);
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
  .option("--execute")
  .option("--non-interactive")
  .option("--json")
  .action(async (options: JsonOptions & { execute?: boolean }) => {
    const service = new OracleAdapterService();
    const status = await service.status();
    if (status.config === null) throw new Error("Oracle adapter is not configured");
    const transport = new ChatGptLoopbackCdpTransport({ endpoint: status.config.cdpEndpoint });
    const config = await loadOmniCodexConfig();
    const o = config.oracle;
    if (o === undefined) throw new Error("Oracle adapter is not configured");
    const selected = await selectBoundOracleSurface(transport, o);
    const { session, surface } = selected;
    try {
      const result = await service.test(surface, options.execute === true, {
        sessionId: o.runId,
        correlationId: session.sessionIdentity,
      });
      emit(
        result,
        options.json === true,
        options.execute === true
          ? "Oracle consent flow verified."
          : "Oracle test dry-run verified exact candidate; no click performed.",
      );
    } finally {
      session.close();
    }
  });

async function selectBoundOracleSurface(
  transport: ChatGptLoopbackCdpTransport,
  oracle: NonNullable<OmniCodexConfig["oracle"]>,
): Promise<{ session: BoundedCdpSession; surface: CdpChatGptApprovalSurface }> {
  const deadline = Date.now() + 60_000;
  let lastTransientError: Error | undefined;
  while (Date.now() <= deadline) {
    const matches: { session: BoundedCdpSession; surface: CdpChatGptApprovalSurface }[] = [];
    const connectorBoundTargets = await transport.listChatGptTargets(undefined, oracle.connectorId);
    const candidates =
      connectorBoundTargets.length > 0
        ? connectorBoundTargets
        : await transport.listChatGptTargets();
    for (const target of candidates) {
      let session: BoundedCdpSession;
      try {
        session = await BoundedCdpSession.connect(transport, {
          factory: (url) => new WebSocket(url) as unknown as CdpWebSocketLike,
          targetId: target.id,
        });
      } catch (error) {
        lastTransientError = toError(error);
        continue;
      }
      const binding = {
        appConnectorId: oracle.connectorId,
        appName: oracle.connectorName,
        oracleRunId: oracle.runId,
        sessionId: oracle.runId,
        correlationId: session.sessionIdentity,
        mcpServerResource: oracle.resource,
        mcpSurface: oracle.surface,
      };
      const surface = new CdpChatGptApprovalSurface(session, binding, "TASK_OUTCOME: EXECUTED", [
        oracle.connectorName,
        oracle.runId,
      ]);
      try {
        const snapshot = await surface.snapshot();
        const exactConsentVisible = snapshot.nodes.some(
          (node) =>
            node.role.toLocaleLowerCase() === "button" &&
            ["connect", "연결", "always allow", "항상 허용"].includes(
              node.name.trim().toLocaleLowerCase(),
            ),
        );
        if (exactConsentVisible || snapshot.toolResultPresent) matches.push({ session, surface });
        else session.close();
      } catch (error) {
        session.close();
        const candidateError = toError(error);
        if (candidateError.message !== "CHATGPT_TARGET_BINDING_MISMATCH")
          lastTransientError = candidateError;
      }
    }
    if (matches.length === 1) return matches[0] as (typeof matches)[number];
    for (const match of matches) match.session.close();
    if (matches.length > 1) throw new Error("CHATGPT_BOUND_TARGET_AMBIGUOUS");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    lastTransientError === undefined
      ? "CHATGPT_BOUND_TARGET_MISSING"
      : `CHATGPT_BOUND_TARGET_MISSING: ${lastTransientError.message}`,
  );
}

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
  .command("probe")
  .description(
    "Start an isolated hidden runtime, enumerate both MCP surfaces, and call one read tool",
  )
  .option("--json", "emit machine-readable JSON")
  .action(async (options: JsonOptions) => {
    const protectedTargets = [
      { logicalName: "codex-auth", path: join(homedir(), ".codex", "auth.json") },
      { logicalName: "codex-config", path: join(homedir(), ".codex", "config.toml") },
    ];
    const protectedBefore = await Promise.all(protectedTargets.map(observeProtectedFile));
    const resource = "http://127.0.0.1/omnicodex-runtime-probe";
    const service = new OmniCodexGatewayService({
      cwd: process.cwd(),
      port: 0,
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
      const tools = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? undefined : { cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      const readTool = tools.find((tool) => tool.name.endsWith("load_workspace_dependencies"));
      if (readTool === undefined) throw new Error("Installed runtime omitted the probe read tool");
      const readResult = (await client.callTool({
        name: readTool.name,
        arguments: {},
      })) as { readonly isError?: boolean; readonly content: readonly { readonly type: string }[] };
      if (readResult.isError === true) throw new Error("Installed runtime probe read call failed");
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
        fullToolCount: tools.length,
        uniqueToolNames: new Set(tools.map((tool) => tool.name)).size,
        modelToolCount: tools.filter(
          (tool) => isObject(tool._meta?.omnicodex) && tool._meta.omnicodex.modelEffect === "model",
        ).length,
        unknownModelEffectCount: tools.filter(
          (tool) =>
            isObject(tool._meta?.omnicodex) && tool._meta.omnicodex.modelEffect === "unknown",
        ).length,
        readTool: readTool.name,
        readContentTypes: readResult.content.map((content) => content.type),
        protectedFilesUnchanged,
      };
      emit(
        result,
        options.json === true,
        `OmniCodex runtime probe passed (${tools.length} tools).`,
      );
    } finally {
      await client?.close().catch(() => undefined);
      await service.stop();
    }
  });

const autostart = program
  .command("autostart")
  .description("Manage hidden per-user startup at Windows logon");

for (const action of ["enable", "disable", "status"] as const) {
  autostart
    .command(action)
    .description(`${action[0]?.toUpperCase()}${action.slice(1)} OmniCodex logon startup`)
    .option("--json", "emit machine-readable JSON")
    .action(async (options: JsonOptions) => {
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
] as const;

auth
  .command("login")
  .description("Sign in through the official Auth0 CLI device flow and Windows keyring")
  .option("--tenant <origin>", "Auth0 tenant origin; defaults to the configured issuer")
  .option("--auth0-cli <path>", "existing official Auth0 CLI executable")
  .option("--json", "emit machine-readable JSON after login completes")
  .action(async (options: AuthLoginOptions) => {
    await requireStoppedDaemon();
    const config = await loadOptionalOmniCodexConfig();
    const tenant =
      options.tenant ??
      (config === undefined || config.auth.issuer.length === 0 ? undefined : config.auth.issuer);
    const executable = await new Auth0CliInstaller({
      dataDirectory: omniCodexDataDirectory(),
    }).ensure(options.auth0Cli);
    const client = new Auth0CliManagementClient({ executablePath: executable });
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
  });

auth
  .command("setup")
  .description("Idempotently provision the dedicated Auth0 API and strict DCR policy")
  .option("--tenant <origin>", "Auth0 tenant origin; defaults to the configured issuer")
  .option("--auth0-cli <path>", "existing official Auth0 CLI executable")
  .option("--json", "emit machine-readable JSON")
  .action(async (options: AuthSetupOptions) => {
    await requireStoppedDaemon();
    const config = await loadOmniCodexConfig();
    const token = process.env.OMNICODEX_AUTH0_MANAGEMENT_TOKEN;
    delete process.env.OMNICODEX_AUTH0_MANAGEMENT_TOKEN;
    const tenant = options.tenant ?? config.auth.issuer;
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
    const result = await provisioner.provision({
      tenantOrigin: tenant,
      audience: config.auth.audience,
      scope: config.auth.requiredScopes[0] ?? "omnicodex:full",
    });
    emit(
      { ok: true, auth: result },
      options.json === true,
      `Auth0 is ready for ${result.audience} with strict DCR and owner-gated access.`,
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

for (const operation of ["update", "rollback"] as const) {
  program
    .command(operation)
    .description(`${operation} using a shadow-validated staged release`)
    .requiredOption("--staged-path <path>", "shadow-validated staged release path")
    .requiredOption("--active-path <path>", "atomic active release link/path")
    .requiredOption("--validation-result <path>", "JSON shadow-validation result")
    .option("--execute", "perform the atomic switch")
    .option("--non-interactive", "fail instead of prompting")
    .option("--json", "emit machine-readable JSON")
    .action(async (options: ReleaseOptions) => {
      await requireStoppedDaemon();
      const validation: unknown = JSON.parse(
        await readFile(resolve(options.validationResult), "utf8"),
      );
      if (
        !isObject(validation) ||
        validation.ok !== true ||
        validation.stagedPath !== resolve(options.stagedPath)
      )
        throw new Error("A matching successful shadow-validation result is required");
      if (options.execute === true)
        await rename(resolve(options.stagedPath), resolve(options.activePath));
      emit(
        { ok: true, operation, executed: options.execute === true, shadowValidated: true },
        options.json === true,
        `${operation} ${options.execute === true ? "completed" : "dry-run complete"}.`,
      );
    });
}

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
      signal: AbortSignal.timeout(10_000),
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
    const tunnelConfig = {
      kind: "ngrok" as const,
      executablePath,
      publicUrl: options.url,
      ...(credentialRef === undefined ? {} : { credentialRef }),
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

await program.parseAsync(process.argv);

interface JsonOptions {
  readonly json?: boolean;
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
}

interface AuthLoginOptions extends JsonOptions {
  readonly tenant?: string;
  readonly auth0Cli?: string;
}

interface ExternalTunnelOptions extends JsonOptions {
  readonly url: string;
  readonly executable: string;
  readonly credentialRef?: string;
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
interface ReleaseOptions extends JsonOptions {
  readonly stagedPath: string;
  readonly activePath: string;
  readonly validationResult: string;
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

async function launchDaemon(): Promise<OmniCodexDaemonState> {
  const daemonPath = resolve(dirname(fileURLToPath(import.meta.url)), "daemon.js");
  const instanceNonce = randomBytes(32).toString("base64url");
  const child = spawnHidden(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OMNICODEX_DAEMON: "1", OMNICODEX_DAEMON_INSTANCE_NONCE: instanceNonce },
  });
  if (child.pid === undefined) {
    terminateOwnedHiddenChild(child);
    throw new Error("OmniCodex daemon did not receive a process id");
  }
  child.unref();
  try {
    const state = await waitForDaemon(child, instanceNonce, 180_000);
    if (state.lifecycle === "failed") throw new Error(state.error ?? "OmniCodex daemon failed");
    return state;
  } catch (error) {
    terminateOwnedHiddenChild(child);
    throw error;
  }
}

async function waitForDaemon(
  child: OwnedHiddenChildProcess,
  instanceNonce: string,
  timeoutMs: number,
): Promise<OmniCodexDaemonState> {
  const pid = child.pid;
  if (pid === undefined) throw new Error("OmniCodex daemon did not receive a process id");
  const deadline = Date.now() + timeoutMs;
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

interface DaemonControlResponse {
  readonly ok: true;
  readonly pid: number;
  readonly instanceNonce: string;
  readonly startedAtUnixMs: number;
  readonly lifecycle: OmniCodexDaemonState["lifecycle"];
}

async function daemonOwnershipIsLive(state: OmniCodexDaemonState): Promise<boolean> {
  return requestDaemonControl(state, "status").then(
    () => true,
    () => false,
  );
}

async function waitForDaemonControlClose(
  state: OmniCodexDaemonState,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let consecutiveClosedChecks = 0;
  while (Date.now() < deadline) {
    if (await daemonOwnershipIsLive(state)) consecutiveClosedChecks = 0;
    else consecutiveClosedChecks += 1;
    if (consecutiveClosedChecks >= 3) return;
    await delay(200);
  }
  throw new Error("OmniCodex did not close its authenticated control channel within 30 seconds");
}

function requestDaemonControl(
  state: OmniCodexDaemonState,
  command: "status" | "stop",
): Promise<DaemonControlResponse> {
  return new Promise((resolveControl, rejectControl) => {
    const socket = connect(state.controlPipe);
    socket.setEncoding("utf8");
    let input = "";
    let settled = false;
    const finish = (error: Error | undefined, response?: DaemonControlResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== undefined) rejectControl(error);
      else if (response !== undefined) resolveControl(response);
      else rejectControl(new Error("OmniCodex control response was empty"));
    };
    const timer = setTimeout(
      () => finish(new Error("OmniCodex authenticated control request timed out")),
      2_000,
    );
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({
          command,
          token: state.controlToken,
          expectedPid: state.pid,
          expectedInstanceNonce: state.instanceNonce,
          expectedStartedAtUnixMs: state.startedAtUnixMs,
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 8_192) {
        finish(new Error("OmniCodex control response exceeded the safety limit"));
        return;
      }
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
        parsed.ok !== true ||
        parsed.pid !== state.pid ||
        parsed.instanceNonce !== state.instanceNonce ||
        parsed.startedAtUnixMs !== state.startedAtUnixMs ||
        !isDaemonLifecycle(parsed.lifecycle)
      ) {
        finish(new Error("OmniCodex control ownership proof was rejected"));
        return;
      }
      finish(undefined, parsed as unknown as DaemonControlResponse);
    });
  });
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

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be 0-65535");
  }
  return port;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new Error("Value must be an integer from 1 to 1000");
  }
  return parsed;
}

function autostartManager(): WindowsAutostartManager {
  return new WindowsAutostartManager(autostartManagerOptions());
}

function autostartManagerOptions() {
  return { nodeExecutable: process.execPath, cliScript: fileURLToPath(import.meta.url) };
}

function emit(value: unknown, json: boolean, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publicDaemonState(state: Awaited<ReturnType<typeof readOmniCodexDaemonState>>): unknown {
  if (state === undefined) return undefined;
  const result: Record<string, unknown> = { ...state };
  delete result.controlPipe;
  delete result.controlToken;
  delete result.instanceNonce;
  return result;
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
      throw new Error("Daemon ownership is unverifiable; refusing to change tunnel configuration");
    }
    throw new Error("Stop OmniCodex before changing its tunnel configuration");
  }
}

function isDaemonLifecycle(value: unknown): value is OmniCodexDaemonState["lifecycle"] {
  return value === "starting" || value === "ready" || value === "stopping" || value === "failed";
}

async function resolveNgrokExecutable(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) {
    const candidate = resolve(explicit);
    await access(candidate);
    return candidate;
  }
  const pathEntries = (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
  const names = process.platform === "win32" ? ["ngrok.exe", "ngrok"] : ["ngrok"];
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = join(entry, name);
      try {
        await access(candidate);
        return resolve(candidate);
      } catch {
        // Continue searching without invoking a shell or where.exe.
      }
    }
  }
  return new NgrokInstaller({ dataDirectory: omniCodexDataDirectory() }).ensure();
}
