import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface OmniCodexAuthConfig {
  readonly issuer: string;
  readonly audience: string;
  readonly resource?: string;
  readonly requiredScopes: readonly string[];
  readonly allowedSubjects: readonly string[];
  readonly jwksUri?: string;
  readonly managementCredentialRef?: string;
  readonly previousManagementCredentialRef?: string;
}

export interface OmniCodexNgrokTunnelConfig {
  readonly kind: "ngrok";
  readonly executablePath: string;
  /** Reserved stable HTTPS origin, for example https://owner.ngrok.app. */
  readonly publicUrl: string;
  readonly credentialRef: string;
}

export interface OmniCodexExternalTunnelConfig {
  readonly kind: "cloudflare" | "tailscale";
  readonly executablePath: string;
  readonly publicUrl: string;
  readonly credentialRef?: string;
}

export interface OmniCodexDirectTunnelConfig {
  readonly kind: "direct";
  readonly publicUrl: string;
}

export type OmniCodexTunnelConfig =
  | OmniCodexNgrokTunnelConfig
  | OmniCodexExternalTunnelConfig
  | OmniCodexDirectTunnelConfig;
export interface OmniCodexOracleConfig {
  readonly enabled: boolean;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly runId: string;
  readonly resource: string;
  readonly surface: "/mcp" | "/mcp/full";
  readonly cdpEndpoint: string;
  readonly freshLiveVerification: "pending" | "verified";
  readonly lastReceipts?: readonly {
    readonly timestamp: string;
    readonly action: "connect" | "always_allow";
    readonly correlationId: string;
    readonly beforeStateHash: string;
    readonly afterStateHash: string;
  }[];
}

export interface OmniCodexConfig {
  readonly schemaVersion: 1;
  /** Present only for a secret-free Oracle companion bootstrap. */
  readonly companionOnly?: true;
  readonly projectRoot: string;
  readonly gateway: {
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly path: string;
    readonly fullPath: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly auth: OmniCodexAuthConfig;
  readonly tunnel?: OmniCodexTunnelConfig;
  readonly oracle?: OmniCodexOracleConfig;
}

export interface OmniCodexDaemonState {
  readonly schemaVersion: 1;
  readonly lifecycle: "starting" | "ready" | "stopping" | "failed";
  readonly pid: number;
  readonly instanceNonce: string;
  readonly startedAtUnixMs: number;
  readonly updatedAtUnixMs: number;
  readonly controlPipe: string;
  readonly controlToken: string;
  readonly address?: {
    readonly host: string;
    readonly port: number;
    readonly path: string;
    readonly fullPath: string;
  };
  readonly runtimePath?: string;
  readonly tunnel?: {
    readonly kind: OmniCodexTunnelConfig["kind"];
    readonly publicUrl: string;
    readonly pid: number;
  };
  readonly error?: string;
}

export function omniCodexDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OMNICODEX_DATA_DIR;
  if (override !== undefined && override.length > 0) return resolve(override);
  const localAppData = env.LOCALAPPDATA;
  if (localAppData === undefined || localAppData.length === 0) {
    throw new Error("LOCALAPPDATA is unavailable");
  }
  return join(localAppData, "OmniCodex");
}

export function omniCodexConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(omniCodexDataDirectory(env), "config.json");
}

export function omniCodexStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(omniCodexDataDirectory(env), "state.json");
}

export async function loadOmniCodexConfig(path = omniCodexConfigPath()): Promise<OmniCodexConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      throw new Error(`OmniCodex is not initialized; missing ${path}`);
    }
    throw error;
  }
  return validateConfig(parsed);
}

export async function loadOptionalOmniCodexConfig(
  path = omniCodexConfigPath(),
): Promise<OmniCodexConfig | undefined> {
  try {
    return await loadOmniCodexConfig(path);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT" || String(error).includes("is not initialized; missing")) {
      return undefined;
    }
    throw error;
  }
}

export function assertGatewayConfigured(config: OmniCodexConfig): OmniCodexConfig {
  if (config.companionOnly === true) {
    throw new Error(
      "OmniCodex gateway is not configured; companion-only initialization cannot start the runtime",
    );
  }
  return config;
}

export async function saveOmniCodexConfig(
  config: OmniCodexConfig,
  path = omniCodexConfigPath(),
): Promise<void> {
  const validated = validateConfig(config);
  await atomicJsonWrite(path, validated);
}

/**
 * Promotes a companion-only or existing gateway config without dropping
 * independently configured Oracle, tunnel, or opaque credential references.
 */
export function mergeGatewayInitialization(
  next: OmniCodexConfig,
  existing?: OmniCodexConfig,
): OmniCodexConfig {
  if (next.companionOnly === true) {
    throw new Error("Gateway initialization cannot remain companion-only");
  }
  if (existing === undefined) return validateConfig(next);
  const merged: OmniCodexConfig = {
    ...next,
    auth: {
      ...next.auth,
      ...(existing.auth.managementCredentialRef === undefined
        ? {}
        : { managementCredentialRef: existing.auth.managementCredentialRef }),
      ...(existing.auth.previousManagementCredentialRef === undefined
        ? {}
        : { previousManagementCredentialRef: existing.auth.previousManagementCredentialRef }),
    },
    ...(existing.tunnel === undefined ? {} : { tunnel: existing.tunnel }),
    ...(existing.oracle === undefined ? {} : { oracle: existing.oracle }),
  };
  return validateConfig(merged);
}

export async function readOmniCodexDaemonState(
  path = omniCodexStatePath(),
): Promise<OmniCodexDaemonState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return validateState(parsed);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeOmniCodexDaemonState(
  state: OmniCodexDaemonState,
  path = omniCodexStatePath(),
): Promise<void> {
  await atomicJsonWrite(path, validateState(state));
}

export function daemonControlPipe(env: NodeJS.ProcessEnv = process.env): string {
  const identity = `${env.USERDOMAIN ?? ""}\\${env.USERNAME ?? "unknown"}`.toLowerCase();
  const digest = Buffer.from(identity, "utf8").toString("base64url").slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omnicodex-${digest}`
    : join(omniCodexDataDirectory(env), `control-${digest}.sock`);
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, absolute);
}

function validateConfig(value: unknown): OmniCodexConfig {
  if (!isObject(value) || value.schemaVersion !== 1)
    throw new Error("Invalid OmniCodex config schema");
  const gateway = value.gateway;
  const auth = value.auth;
  if (!isObject(gateway) || gateway.host !== "127.0.0.1")
    throw new Error("OmniCodex gateway must bind to 127.0.0.1");
  if (
    !Number.isInteger(gateway.port) ||
    (gateway.port as number) < 0 ||
    (gateway.port as number) > 65535
  )
    throw new Error("Invalid OmniCodex gateway port");
  if (!isObject(auth)) throw new Error("Invalid OmniCodex auth config");
  const config = value as unknown as OmniCodexConfig;
  if (typeof config.projectRoot !== "string" || config.projectRoot.length === 0)
    throw new Error("Invalid OmniCodex project root");
  if (typeof config.gateway.path !== "string" || typeof config.gateway.fullPath !== "string")
    throw new Error("Invalid OmniCodex MCP paths");
  if (
    !Array.isArray(config.gateway.allowedOrigins) ||
    !config.gateway.allowedOrigins.every((item) => typeof item === "string")
  )
    throw new Error("Invalid OmniCodex allowed origins");
  if (typeof config.auth.issuer !== "string" || typeof config.auth.audience !== "string")
    throw new Error("Invalid OmniCodex issuer or audience");
  if (config.companionOnly === true) {
    if (
      config.auth.issuer !== "" ||
      config.auth.audience !== "" ||
      config.auth.resource !== undefined ||
      config.auth.allowedSubjects.length !== 0 ||
      config.auth.requiredScopes.length !== 0 ||
      config.tunnel !== undefined
    ) {
      throw new Error(
        "Companion-only config must not contain gateway authorization or tunnel data",
      );
    }
  }
  if (
    !Array.isArray(config.auth.allowedSubjects) ||
    (config.companionOnly !== true && config.auth.allowedSubjects.length === 0) ||
    !config.auth.allowedSubjects.every((item) => typeof item === "string" && item.length > 0)
  )
    throw new Error("OmniCodex requires an allowed subject");
  if (
    !Array.isArray(config.auth.requiredScopes) ||
    !config.auth.requiredScopes.every((item) => typeof item === "string" && item.length > 0)
  )
    throw new Error("Invalid OmniCodex required scopes");
  for (const reference of [
    config.auth.managementCredentialRef,
    config.auth.previousManagementCredentialRef,
  ]) {
    if (reference !== undefined && !/^[A-Za-z0-9._:/-]{1,512}$/.test(reference))
      throw new Error("Invalid auth credential reference");
  }
  if (config.tunnel !== undefined) validateTunnel(config.tunnel, config.auth);
  if (config.oracle !== undefined) validateOracle(config.oracle);
  return structuredClone(config);
}
function validateOracle(value: OmniCodexOracleConfig): void {
  if (
    typeof value.enabled !== "boolean" ||
    ![value.connectorId, value.connectorName, value.runId].every(
      (v) => typeof v === "string" && v.trim() !== "",
    ) ||
    !(value.surface === "/mcp" || value.surface === "/mcp/full")
  )
    throw new Error("Invalid Oracle adapter config");
  const resource = new URL(value.resource);
  if (resource.protocol !== "https:" || resource.username !== "" || resource.password !== "")
    throw new Error("Oracle resource must be a credential-free HTTPS URL");
  const endpoint = new URL(value.cdpEndpoint);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.port === ""
  )
    throw new Error("Oracle CDP endpoint must be explicit loopback");
  if (value.freshLiveVerification !== "pending" && value.freshLiveVerification !== "verified")
    throw new Error("Invalid Oracle verification state");
  if (
    value.lastReceipts !== undefined &&
    (!Array.isArray(value.lastReceipts) ||
      value.lastReceipts.length < 1 ||
      value.lastReceipts.length > 2 ||
      !value.lastReceipts.every(
        (receipt) =>
          isObject(receipt) &&
          typeof receipt.timestamp === "string" &&
          (receipt.action === "connect" || receipt.action === "always_allow") &&
          typeof receipt.correlationId === "string" &&
          /^[a-f0-9]{64}$/.test(String(receipt.beforeStateHash)) &&
          /^[a-f0-9]{64}$/.test(String(receipt.afterStateHash)),
      ))
  )
    throw new Error("Invalid Oracle receipt set");
}

function validateState(value: unknown): OmniCodexDaemonState {
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    !isLifecycle(value.lifecycle) ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    typeof value.instanceNonce !== "string" ||
    value.instanceNonce.length < 32 ||
    typeof value.startedAtUnixMs !== "number" ||
    typeof value.updatedAtUnixMs !== "number" ||
    typeof value.controlPipe !== "string" ||
    value.controlPipe.length === 0 ||
    typeof value.controlToken !== "string" ||
    value.controlToken.length < 32
  )
    throw new Error("Invalid OmniCodex daemon state");
  if (value.tunnel !== undefined) {
    const tunnel = value.tunnel;
    if (
      !isObject(tunnel) ||
      !isTunnelKind(tunnel.kind) ||
      typeof tunnel.publicUrl !== "string" ||
      !Number.isInteger(tunnel.pid) ||
      (tunnel.pid as number) <= 0
    ) {
      throw new Error("Invalid OmniCodex daemon tunnel state");
    }
  }
  return structuredClone(value as unknown as OmniCodexDaemonState);
}

function validateTunnel(tunnel: OmniCodexTunnelConfig, auth: OmniCodexAuthConfig): void {
  if (!isTunnelKind(tunnel.kind)) {
    throw new Error("Invalid OmniCodex tunnel config");
  }
  if (
    tunnel.kind !== "direct" &&
    (typeof tunnel.executablePath !== "string" || tunnel.executablePath.length === 0)
  )
    throw new Error("Invalid OmniCodex tunnel executable");
  if (
    "credentialRef" in tunnel &&
    tunnel.credentialRef !== undefined &&
    !/^[A-Za-z0-9._:/-]{1,512}$/.test(tunnel.credentialRef)
  )
    throw new Error("Invalid tunnel credential reference");
  if (tunnel.kind === "ngrok" && !tunnel.credentialRef.startsWith("dpapi:v1:"))
    throw new Error("ngrok requires a CurrentUser DPAPI credential reference");
  const publicUrl = parseStableHttpsOrigin(tunnel.publicUrl);
  const protectedResource = auth.resource ?? auth.audience;
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(protectedResource);
  } catch {
    throw new Error("OmniCodex tunnel requires a URL-shaped OAuth resource");
  }
  if (resourceUrl.origin !== publicUrl.origin) {
    throw new Error("OmniCodex tunnel origin must match the OAuth protected resource origin");
  }
}

function isTunnelKind(value: unknown): value is OmniCodexTunnelConfig["kind"] {
  return value === "ngrok" || value === "cloudflare" || value === "tailscale" || value === "direct";
}

function parseStableHttpsOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OmniCodex tunnel public URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("OmniCodex tunnel public URL must be a credential-free HTTPS origin");
  }
  return url;
}

function isLifecycle(value: unknown): value is OmniCodexDaemonState["lifecycle"] {
  return value === "starting" || value === "ready" || value === "stopping" || value === "failed";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}
