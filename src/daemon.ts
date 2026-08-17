#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { OmniCodexGatewayService } from "./application/omnicodex-gateway-service.js";
import { OracleAdapterService } from "./application/oracle-adapter-service.js";
import { JwtBearerAuthorizer } from "./infrastructure/auth/jwt-bearer-authorizer.js";
import {
  assertGatewayConfigured,
  daemonControlPipe,
  loadOmniCodexConfig,
  type OmniCodexDaemonState,
  writeOmniCodexDaemonState,
} from "./infrastructure/config/omnicodex-config-store.js";
import { OmniCodexOperationalLog } from "./infrastructure/operations/operational-log.js";
import { ExternalTunnelSupervisor } from "./infrastructure/tunnel/external-tunnel-supervisor.js";
import { NgrokTunnelSupervisor } from "./infrastructure/tunnel/ngrok-tunnel-supervisor.js";

const config = assertGatewayConfigured(await loadOmniCodexConfig());
const controlPipe = daemonControlPipe();
const controlToken = randomBytes(32).toString("base64url");
const instanceNonce = requiredInstanceNonce(process.env.OMNICODEX_DAEMON_INSTANCE_NONCE);
const startedAtUnixMs = Date.now();
const operationalLog = new OmniCodexOperationalLog();
let lifecycle: OmniCodexDaemonState["lifecycle"] = "starting";
let stopping = false;
let tunnelSupervisor: NgrokTunnelSupervisor | ExternalTunnelSupervisor | undefined;

const authorizer = new JwtBearerAuthorizer({
  issuer: config.auth.issuer,
  audience: config.auth.audience,
  ...(config.auth.resource === undefined ? {} : { resource: config.auth.resource }),
  requiredScopes: config.auth.requiredScopes,
  allowedSubjects: config.auth.allowedSubjects,
  ...(config.auth.jwksUri === undefined ? {} : { jwksUri: config.auth.jwksUri }),
});
const service = new OmniCodexGatewayService({
  cwd: config.projectRoot,
  host: config.gateway.host,
  port: config.gateway.port,
  path: config.gateway.path,
  fullPath: config.gateway.fullPath,
  allowedOrigins: config.gateway.allowedOrigins,
  protectedResourceMetadata: {
    resource: config.auth.resource ?? config.auth.audience,
    authorization_servers: [config.auth.issuer],
    scopes_supported: config.auth.requiredScopes,
    bearer_methods_supported: ["header"],
  },
  authorize: async (request) => {
    const decision = await authorizer.authorize(request);
    if (!decision.ok) {
      await operationalLog
        .append("authorization_failed", {
          remoteAddress: request.socket.remoteAddress ?? "unknown",
          status: decision.status ?? 401,
        })
        .catch(() => undefined);
    }
    return decision;
  },
});

let controlServer: Server | undefined;

try {
  await operationalLog.append("daemon_starting");
  controlServer = await startControlServer(
    controlPipe,
    controlToken,
    { pid: process.pid, instanceNonce, startedAtUnixMs },
    () => lifecycle,
    async () => shutdown(0),
  );
  await persistState();
  const status = await service.start();
  if (config.oracle?.enabled === true) {
    try {
      const oracleStatus = await new OracleAdapterService().status();
      if (!oracleStatus.complete || !oracleStatus.cdpEndpointValid)
        throw new Error("Oracle adapter configuration is incomplete");
      await operationalLog.append("oracle_adapter_ready", {
        freshLiveVerification: oracleStatus.freshLiveVerification,
      });
    } catch (error) {
      await operationalLog.append("oracle_adapter_failed_closed", {
        error: toError(error).message,
        gatewayContinues: true,
      });
    }
  }
  if (config.tunnel !== undefined) {
    if (status.address === undefined)
      throw new Error("Gateway address is unavailable for tunneling");
    if (config.tunnel.kind === "ngrok") {
      tunnelSupervisor = new NgrokTunnelSupervisor({
        ...config.tunnel,
        expectedResource: config.auth.resource ?? config.auth.audience,
      });
      await tunnelSupervisor.start(status.address);
    } else if (config.tunnel.kind !== "direct") {
      tunnelSupervisor = new ExternalTunnelSupervisor({
        kind: config.tunnel.kind,
        executablePath: config.tunnel.executablePath,
        publicUrl: config.tunnel.publicUrl,
      });
      await tunnelSupervisor.start(status.address);
    }
  }
  lifecycle = "ready";
  await persistState({
    ...(status.address === undefined ? {} : { address: status.address }),
    ...(status.candidate === undefined ? {} : { runtimePath: status.candidate.canonicalPath }),
    ...(tunnelSupervisor?.status === undefined
      ? {}
      : {
          tunnel: {
            kind: tunnelSupervisor.status.kind,
            publicUrl: tunnelSupervisor.status.publicUrl,
            pid: tunnelSupervisor.status.pid,
          },
        }),
  });
  await operationalLog.append("daemon_ready", {
    runtimePath: status.candidate?.canonicalPath ?? "unknown",
    port: status.address?.port ?? 0,
    tunnel: tunnelSupervisor?.status?.kind ?? "none",
  });
} catch (error) {
  lifecycle = "failed";
  await operationalLog
    .append("daemon_failed", { error: toError(error).message })
    .catch(() => undefined);
  await persistState({ error: toError(error).message }).catch(() => undefined);
  await tunnelSupervisor?.stop().catch(() => undefined);
  await service.stop().catch(() => undefined);
  await closeControlServer(controlServer);
  process.exitCode = 1;
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  lifecycle = "stopping";
  await operationalLog.append("daemon_stopping").catch(() => undefined);
  await persistState().catch(() => undefined);
  await tunnelSupervisor?.stop().catch(() => undefined);
  await service.stop().catch(() => undefined);
  await closeControlServer(controlServer);
  await operationalLog.append("daemon_stopped").catch(() => undefined);
  process.exitCode = exitCode;
  setImmediate(() => process.exit(exitCode));
}

async function persistState(
  fields: Partial<Pick<OmniCodexDaemonState, "address" | "runtimePath" | "tunnel" | "error">> = {},
): Promise<void> {
  await writeOmniCodexDaemonState({
    schemaVersion: 1,
    lifecycle,
    pid: process.pid,
    instanceNonce,
    startedAtUnixMs,
    updatedAtUnixMs: Date.now(),
    controlPipe,
    controlToken,
    ...fields,
  });
}

async function startControlServer(
  pipe: string,
  token: string,
  identity: DaemonControlIdentity,
  getLifecycle: () => OmniCodexDaemonState["lifecycle"],
  onStop: () => Promise<void>,
): Promise<Server> {
  const server = createServer((socket) =>
    handleControlSocket(socket, token, identity, getLifecycle, onStop),
  );
  await new Promise<void>((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(pipe, () => {
      server.removeListener("error", rejectStart);
      resolveStart();
    });
  });
  return server;
}

interface DaemonControlIdentity {
  readonly pid: number;
  readonly instanceNonce: string;
  readonly startedAtUnixMs: number;
}

function handleControlSocket(
  socket: Socket,
  token: string,
  identity: DaemonControlIdentity,
  getLifecycle: () => OmniCodexDaemonState["lifecycle"],
  onStop: () => Promise<void>,
): void {
  socket.setEncoding("utf8");
  let input = "";
  socket.on("data", (chunk: string) => {
    input += chunk;
    if (input.length > 8_192) socket.destroy();
    const newline = input.indexOf("\n");
    if (newline < 0) return;
    try {
      const request: unknown = JSON.parse(input.slice(0, newline));
      if (
        !isObject(request) ||
        request.token !== token ||
        request.expectedPid !== identity.pid ||
        request.expectedInstanceNonce !== identity.instanceNonce ||
        request.expectedStartedAtUnixMs !== identity.startedAtUnixMs ||
        (request.command !== "status" && request.command !== "stop")
      ) {
        socket.end(`${JSON.stringify({ ok: false })}\n`);
        return;
      }
      socket.end(`${JSON.stringify({ ok: true, ...identity, lifecycle: getLifecycle() })}\n`);
      if (request.command === "stop") void onStop();
    } catch {
      socket.end(`${JSON.stringify({ ok: false })}\n`);
    }
  });
}

async function closeControlServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requiredInstanceNonce(value: string | undefined): string {
  if (value === undefined || value.length < 32 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("OmniCodex daemon requires a strong launch instance nonce");
  }
  return value;
}
