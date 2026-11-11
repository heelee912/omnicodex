import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { captureHiddenProcessOutputSync } from "../windows/hidden-child-process.js";

export const OMNICODEX_CONNECTOR_NAME = "OmniCodex" as const;
export const OMNICODEX_MCP_SURFACE = "/mcp/full" as const;

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

/**
 * A dedicated reverse-SSH backhaul into the isolated Oracle HTTPS ingress.
 * The identity is transport-only and must not be shared with an operator or
 * any other Oracle workload.
 */
export interface OmniCodexOracleSshTunnelConfig {
  readonly kind: "oracle_ssh";
  readonly executablePath: string;
  readonly publicUrl: string;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly identityFile: string;
  readonly remotePort: number;
}

export interface OmniCodexDirectTunnelConfig {
  readonly kind: "direct";
  readonly publicUrl: string;
}

export type OmniCodexTunnelConfig =
  | OmniCodexNgrokTunnelConfig
  | OmniCodexExternalTunnelConfig
  | OmniCodexOracleSshTunnelConfig
  | OmniCodexDirectTunnelConfig;
export interface OmniCodexOracleRegistration {
  readonly kind: "secure_mcp_tunnel";
  readonly tunnelId: string;
}

export interface OmniCodexOracleClientBinding {
  readonly enabled: boolean;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly runId: string;
  readonly resource: string;
  /** Host registration endpoint; resource remains the exact OAuth audience. */
  readonly endpoint?: string;
  /** Host-issued tunnel registration; it has no public HTTP endpoint URL. */
  readonly registration?: OmniCodexOracleRegistration;
  /** Opaque version issued by the registering Chat host, never synthesized. */
  readonly actionVersionId?: string;
  readonly surface: typeof OMNICODEX_MCP_SURFACE;
  readonly cdpEndpoint: string;
  /**
   * Optional SSH transport to an Oracle-owned loopback CDP browser. The local
   * process is only a hidden TCP forward; rendering and approval observation
   * remain on the isolated Oracle host.
   */
  readonly remoteCdpTunnel?: {
    readonly sshHost: string;
    readonly sshPort: number;
    readonly sshUser: string;
    readonly identityFile: string;
    readonly remoteCdpPort: number;
  };
  readonly freshLiveVerification: "pending" | "verified";
  /** Current-run hash-only settings readback. It never claims that a control was clicked. */
  readonly lastStateVerification?: {
    readonly timestamp: string;
    readonly correlationId: string;
    /** Exact MCP resource whose Connect and permission state was read back. */
    readonly resource?: string;
    readonly connected: true;
    readonly fullAccess: true;
    readonly stateHash: string;
  };
  /**
   * Proof that ChatGPT activated the exact first-class catalog served by the
   * current daemon. Connection and permission readback alone never creates
   * this record.
   */
  readonly lastActionCatalogVerification?: {
    readonly timestamp: string;
    readonly correlationId: string;
    readonly verificationSource: "post_click_mcp_catalog" | "chatgpt_control_plane_catalog";
    readonly daemonPid: number;
    readonly catalogRevision: string;
    readonly catalogToolCount: number;
    readonly catalogPageToolCounts: readonly number[];
    /** Present only for exact server-vs-ChatGPT action-name parity verification. */
    readonly catalogToolNamesSha256?: string;
    /** Complete eager action contract associated with the successful Refresh receipt. */
    readonly catalogContractSha256?: string;
    readonly visibleActionToolCount?: number;
    readonly visibleActionNamesSha256?: string;
    readonly actionSchemaHash: string;
    readonly verifiedActionNames: readonly string[];
  };
  /**
   * Durable metadata for one exact settings-side Connect click whose OAuth
   * handoff has not yet been read back as connected. It contains no token,
   * URL query, DOM text, or credential material.
   */
  readonly pendingConnectAttempt?: {
    readonly timestamp: string;
    readonly correlationId: string;
    readonly selectorClass: "accessible-role-name" | "bounded-selector-fallback";
    readonly beforeStateHash: string;
    readonly clickStateHash: string;
  };
  readonly lastReceipts?: readonly {
    readonly timestamp: string;
    readonly action: "connect" | "always_allow";
    readonly consentStrength: "connection" | "low_risk" | "persistent" | "full_access";
    readonly evidenceSource: "settings_reconcile" | "conversation_watcher";
    readonly correlationId: string;
    readonly beforeStateHash: string;
    readonly afterStateHash: string;
  }[];
}

export interface OmniCodexOracleConfig extends OmniCodexOracleClientBinding {
  /**
   * Independent registrations for the same service, normally `web` and `desktop`.
   * The top-level binding is retained only for installed singleton-config consumers.
   * Once web exists it is the top-level projection; desktop never replaces it.
   */
  readonly clientBindings?: Readonly<Record<string, OmniCodexOracleClientBinding>>;
  readonly primaryClientBinding?: string;
}

export function getOracleClientBindings(
  oracle: OmniCodexOracleConfig | undefined,
): Readonly<Record<string, OmniCodexOracleClientBinding>> {
  if (oracle === undefined) return {};
  const { clientBindings, primaryClientBinding, ...primary } = oracle;
  return {
    ...structuredClone(clientBindings ?? {}),
    [primaryClientBinding ?? "web"]: {
      ...structuredClone(primary),
      ...(primary.registration === undefined
        ? { endpoint: primary.endpoint ?? primary.resource }
        : {}),
    },
  };
}

export function selectOracleClientConfig(
  config: OmniCodexConfig,
  clientBinding = "web",
): OmniCodexConfig {
  assertOracleClientBindingKey(clientBinding);
  const bindings = getOracleClientBindings(config.oracle);
  const { oracle: _oracle, ...rest } = config;
  const selected = Object.hasOwn(bindings, clientBinding) ? bindings[clientBinding] : undefined;
  return selected === undefined ? rest : { ...rest, oracle: structuredClone(selected) };
}

/** Selects the shared approval transport without changing either registration. */
export function getOracleRuntimeBinding(
  oracle: OmniCodexOracleConfig | undefined,
): OmniCodexOracleClientBinding | undefined {
  const bindings = getOracleClientBindings(oracle);
  const primary = bindings[oracle?.primaryClientBinding ?? "web"];
  return primary?.enabled === true
    ? primary
    : Object.values(bindings).find((binding) => binding.enabled);
}

export function withOracleClientBinding(
  config: OmniCodexConfig,
  clientBinding: string,
  binding: OmniCodexOracleClientBinding,
): OmniCodexConfig {
  assertOracleClientBindingKey(clientBinding);
  const bindings = {
    ...getOracleClientBindings(config.oracle),
    [clientBinding]: {
      ...structuredClone(binding),
      ...(binding.registration === undefined
        ? { endpoint: binding.endpoint ?? binding.resource }
        : {}),
    },
  };
  const primary = Object.hasOwn(bindings, "web")
    ? "web"
    : (config.oracle?.primaryClientBinding ?? clientBinding);
  const primaryBinding = bindings[primary];
  if (primaryBinding === undefined) throw new Error("Oracle primary client binding is missing");
  return {
    ...config,
    oracle: {
      ...structuredClone(primaryBinding),
      primaryClientBinding: primary,
      clientBindings: bindings,
    },
  };
}

function assertOracleClientBindingKey(value: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error("Invalid Oracle client binding key");
  }
}

export function hasExactActionCatalogNameParity(
  verification: OmniCodexOracleConfig["lastActionCatalogVerification"] | undefined,
): verification is NonNullable<OmniCodexOracleConfig["lastActionCatalogVerification"]> {
  return (
    verification !== undefined &&
    verification.visibleActionToolCount === verification.catalogToolCount &&
    typeof verification.catalogToolNamesSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(verification.catalogToolNamesSha256) &&
    verification.visibleActionNamesSha256 === verification.catalogToolNamesSha256
  );
}

export function hasExactActionCatalogContractParity(
  verification: OmniCodexOracleConfig["lastActionCatalogVerification"] | undefined,
): verification is NonNullable<OmniCodexOracleConfig["lastActionCatalogVerification"]> {
  return (
    hasExactActionCatalogNameParity(verification) &&
    typeof verification.catalogContractSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(verification.catalogContractSha256)
  );
}

export interface OmniCodexConfig {
  readonly schemaVersion: 1;
  /** Present only for a secret-free Oracle companion bootstrap. */
  readonly companionOnly?: true;
  readonly projectRoot: string;
  /** Explicit deployment mode; legacy configs retain standard behavior. */
  readonly runtimeMode?: "standard" | "training";
  readonly gateway: {
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly path: string;
    readonly fullPath: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly auth: OmniCodexAuthConfig;
  /** Opaque CurrentUser-DPAPI reference; key material is never stored in config. */
  readonly internal?: {
    readonly integrityMasterKeyRef: string;
  };
  readonly tunnel?: OmniCodexTunnelConfig;
  readonly oracle?: OmniCodexOracleConfig;
}

export interface OmniCodexDaemonState {
  readonly schemaVersion: 1;
  readonly lifecycle:
    | "starting"
    | "shadow_starting"
    | "draining"
    | "switching"
    | "observing"
    | "retiring_previous"
    | "cleanup_pending"
    | "rolling_back"
    | "ready"
    | "stopping"
    | "failed";
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
  readonly releasePath?: string;
  /** SHA-256 identity of the exact executable release currently in memory. */
  readonly releaseFingerprint?: string;
  readonly tunnel?: {
    readonly kind: OmniCodexTunnelConfig["kind"];
    readonly publicUrl: string;
    readonly pid: number;
  };
  /**
   * Private crash-recovery identity for the exact ngrok child. CLI output
   * removes this field; it exists only so a later watchdog can reject PID
   * reuse and reclaim a child whose daemon was hard-killed.
   */
  readonly tunnelOwnership?: {
    readonly kind: "ngrok";
    readonly pid: number;
    readonly parentPid: number;
    readonly processNonce: string;
    readonly executablePath: string;
    readonly spawnedAtUnixMs: number;
    readonly targetUrl: string;
    readonly publicUrl: string;
    readonly configPath: string;
  };
  readonly error?: string;
}

let currentUserLocalAppData: string | undefined;

export function windowsLocalAppData(): string {
  if (currentUserLocalAppData !== undefined) return currentUserLocalAppData;
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (process.platform !== "win32" || systemRoot === undefined || !win32.isAbsolute(systemRoot)) {
    throw new Error(
      "LOCALAPPDATA is unavailable; cannot query the current Windows account's known folder",
    );
  }
  // Query the executing account's Windows known folder, including folder redirection.
  // USERPROFILE/homedir plus AppData/Local is not an equivalent contract.
  const directory = captureHiddenProcessOutputSync(
    win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData))",
    ],
  );
  if (directory.length === 0 || !win32.isAbsolute(directory)) {
    throw new Error("LOCALAPPDATA is unavailable; Windows returned no absolute known folder");
  }
  currentUserLocalAppData = directory;
  return directory;
}

export function omniCodexDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  resolveLocalAppData: () => string = windowsLocalAppData,
): string {
  const override = env.OMNICODEX_DATA_DIR;
  if (override !== undefined && override.length > 0) return resolve(override);
  const localAppData = env.LOCALAPPDATA || resolveLocalAppData();
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
  const protectedResource = next.auth.resource ?? next.auth.audience;
  const protectedResourceOrigin = new URL(protectedResource).origin;
  const migratePublicBindings = existing.companionOnly !== true;
  const merged: OmniCodexConfig = {
    ...next,
    ...(existing.runtimeMode === undefined ? {} : { runtimeMode: existing.runtimeMode }),
    auth: {
      ...next.auth,
      ...(existing.auth.managementCredentialRef === undefined
        ? {}
        : { managementCredentialRef: existing.auth.managementCredentialRef }),
      ...(existing.auth.previousManagementCredentialRef === undefined
        ? {}
        : { previousManagementCredentialRef: existing.auth.previousManagementCredentialRef }),
    },
    ...(existing.tunnel === undefined
      ? {}
      : {
          tunnel: {
            ...existing.tunnel,
            ...(migratePublicBindings ? { publicUrl: protectedResourceOrigin } : {}),
          },
        }),
    ...(existing.oracle === undefined
      ? {}
      : {
          oracle: {
            ...existing.oracle,
            ...(migratePublicBindings
              ? {
                  resource: protectedResource,
                  ...(existing.oracle.registration === undefined
                    ? { endpoint: protectedResource }
                    : {}),
                  ...(existing.oracle.resource === protectedResource
                    ? {}
                    : { freshLiveVerification: "pending" as const }),
                  clientBindings: Object.fromEntries(
                    Object.entries(getOracleClientBindings(existing.oracle)).map(
                      ([key, binding]) => [
                        key,
                        {
                          ...binding,
                          resource: protectedResource,
                          ...(binding.registration === undefined
                            ? { endpoint: protectedResource }
                            : {}),
                          ...(binding.resource === protectedResource
                            ? {}
                            : { freshLiveVerification: "pending" as const }),
                        },
                      ],
                    ),
                  ),
                }
              : {}),
          },
        }),
    ...(existing.internal === undefined ? {} : { internal: existing.internal }),
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
  const dataDirectory = omniCodexDataDirectory(env);
  const digest = createHash("sha256")
    .update(`${identity}\0${dataDirectory.toLocaleLowerCase("en-US")}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\omnicodex-${digest}`
    : join(dataDirectory, `control-${digest}.sock`);
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await atomicRename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicRename(source: string, destination: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  let retryDelayMs = 5;
  while (true) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = getErrorCode(error);
      if (
        process.platform !== "win32" ||
        (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY") ||
        Date.now() + retryDelayMs > deadline
      ) {
        throw error;
      }
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, 100);
    }
  }
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
  if (
    config.runtimeMode !== undefined &&
    config.runtimeMode !== "standard" &&
    config.runtimeMode !== "training"
  )
    throw new Error("Invalid OmniCodex runtime mode");
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
  if (config.oracle !== undefined) {
    validateOracle(config.oracle);
    if (config.oracle.primaryClientBinding !== undefined) {
      assertOracleClientBindingKey(config.oracle.primaryClientBinding);
    }
    if (config.oracle.clientBindings !== undefined) {
      if (!isObject(config.oracle.clientBindings))
        throw new Error("Invalid Oracle client bindings");
      for (const [key, binding] of Object.entries(config.oracle.clientBindings)) {
        assertOracleClientBindingKey(key);
        validateOracle(binding);
        if ("clientBindings" in binding || "primaryClientBinding" in binding) {
          throw new Error("Nested Oracle client bindings are invalid");
        }
      }
    }
  }
  if (
    config.internal !== undefined &&
    (!isObject(config.internal) ||
      Object.keys(config.internal).length !== 1 ||
      !isCurrentUserDpapiReference(config.internal.integrityMasterKeyRef))
  ) {
    throw new Error("Invalid OmniCodex internal integrity-key reference");
  }
  const cloned = structuredClone(config);
  // Older builds treated connection + Full Access as live-tool proof. Keep the
  // binding and receipts, but downgrade that stale assertion until an exact
  // post-click catalog observation is persisted by the current build.
  if (cloned.oracle !== undefined) {
    let migrated = cloned;
    for (const [key, binding] of Object.entries(getOracleClientBindings(cloned.oracle))) {
      const current =
        binding.freshLiveVerification === "verified" &&
        !hasExactActionCatalogContractParity(binding.lastActionCatalogVerification)
          ? { ...binding, freshLiveVerification: "pending" as const }
          : binding;
      migrated = withOracleClientBinding(migrated, key, current);
    }
    return migrated;
  }
  return cloned;
}

function isCurrentUserDpapiReference(value: unknown): value is string {
  return typeof value === "string" && /^dpapi:v1:[A-Za-z0-9_-]{43}$/.test(value);
}

function isOracleMcpResource(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const resource = new URL(value);
    return (
      resource.protocol === "https:" &&
      resource.username === "" &&
      resource.password === "" &&
      resource.pathname === OMNICODEX_MCP_SURFACE &&
      resource.search === "" &&
      resource.hash === ""
    );
  } catch {
    return false;
  }
}

export function assertOracleRegistration(
  registration: OmniCodexOracleRegistration | undefined,
  endpoint: string | undefined,
): void {
  if (registration === undefined) return;
  if (
    !isObject(registration) ||
    registration.kind !== "secure_mcp_tunnel" ||
    typeof registration.tunnelId !== "string" ||
    !/^tunnel_[A-Za-z0-9]+$/.test(registration.tunnelId) ||
    Object.keys(registration).some((key) => key !== "kind" && key !== "tunnelId")
  )
    throw new Error("Invalid Oracle tunnel registration");
  if (endpoint !== undefined) throw new Error("Oracle tunnel registration must omit endpoint");
}

function validateOracle(value: OmniCodexOracleClientBinding): void {
  if (
    typeof value.enabled !== "boolean" ||
    ![value.connectorId, value.connectorName, value.runId].every(
      (v) => typeof v === "string" && v.trim() !== "",
    ) ||
    value.surface !== OMNICODEX_MCP_SURFACE
  )
    throw new Error("Invalid Oracle adapter config");
  assertOracleRegistration(value.registration, value.endpoint);
  const resource = new URL(value.resource);
  if (
    resource.protocol !== "https:" ||
    resource.username !== "" ||
    resource.password !== "" ||
    resource.pathname !== OMNICODEX_MCP_SURFACE ||
    resource.search !== "" ||
    resource.hash !== ""
  )
    throw new Error("Oracle resource must be a credential-free HTTPS URL");
  if (value.endpoint !== undefined && !isOracleMcpResource(value.endpoint)) {
    throw new Error("Oracle endpoint must be a credential-free HTTPS MCP URL");
  }
  if (
    value.actionVersionId !== undefined &&
    (typeof value.actionVersionId !== "string" || value.actionVersionId.trim() === "")
  ) {
    throw new Error("Invalid Oracle host action-version ID");
  }
  const endpoint = new URL(value.cdpEndpoint);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.port === ""
  )
    throw new Error("Oracle CDP endpoint must be explicit loopback");
  if (value.remoteCdpTunnel !== undefined) {
    const remote = value.remoteCdpTunnel;
    if (
      !isObject(remote) ||
      typeof remote.sshHost !== "string" ||
      remote.sshHost.trim() === "" ||
      typeof remote.sshUser !== "string" ||
      remote.sshUser.trim() === "" ||
      typeof remote.identityFile !== "string" ||
      !isAbsolute(remote.identityFile) ||
      !Number.isInteger(remote.sshPort) ||
      remote.sshPort < 1 ||
      remote.sshPort > 65_535 ||
      !Number.isInteger(remote.remoteCdpPort) ||
      remote.remoteCdpPort < 1 ||
      remote.remoteCdpPort > 65_535
    ) {
      throw new Error("Invalid Oracle remote CDP tunnel config");
    }
  }
  if (value.freshLiveVerification !== "pending" && value.freshLiveVerification !== "verified")
    throw new Error("Invalid Oracle verification state");
  if (
    value.lastStateVerification !== undefined &&
    (!isObject(value.lastStateVerification) ||
      typeof value.lastStateVerification.timestamp !== "string" ||
      typeof value.lastStateVerification.correlationId !== "string" ||
      value.lastStateVerification.correlationId.length === 0 ||
      (value.lastStateVerification.resource !== undefined &&
        !isOracleMcpResource(value.lastStateVerification.resource)) ||
      value.lastStateVerification.connected !== true ||
      value.lastStateVerification.fullAccess !== true ||
      !/^[a-f0-9]{64}$/.test(String(value.lastStateVerification.stateHash)))
  ) {
    throw new Error("Invalid Oracle settings-state verification");
  }
  const actionCatalog = value.lastActionCatalogVerification;
  const nameParityFields =
    actionCatalog === undefined
      ? []
      : [
          actionCatalog.catalogToolNamesSha256,
          actionCatalog.visibleActionToolCount,
          actionCatalog.visibleActionNamesSha256,
        ];
  const hasAnyNameParityField = nameParityFields.some((field) => field !== undefined);
  const hasValidNameParity = hasExactActionCatalogNameParity(actionCatalog);
  const hasValidContractParity = hasExactActionCatalogContractParity(actionCatalog);
  if (
    value.lastActionCatalogVerification !== undefined &&
    (!isObject(value.lastActionCatalogVerification) ||
      typeof value.lastActionCatalogVerification.timestamp !== "string" ||
      typeof value.lastActionCatalogVerification.correlationId !== "string" ||
      value.lastActionCatalogVerification.correlationId.length === 0 ||
      !["post_click_mcp_catalog", "chatgpt_control_plane_catalog"].includes(
        String(value.lastActionCatalogVerification.verificationSource),
      ) ||
      !Number.isInteger(value.lastActionCatalogVerification.daemonPid) ||
      value.lastActionCatalogVerification.daemonPid <= 0 ||
      !/^[a-f0-9]{64}$/.test(value.lastActionCatalogVerification.catalogRevision) ||
      !Number.isInteger(value.lastActionCatalogVerification.catalogToolCount) ||
      value.lastActionCatalogVerification.catalogToolCount <= 0 ||
      !Array.isArray(value.lastActionCatalogVerification.catalogPageToolCounts) ||
      value.lastActionCatalogVerification.catalogPageToolCounts.length === 0 ||
      !value.lastActionCatalogVerification.catalogPageToolCounts.every(
        (count) => Number.isInteger(count) && count > 0,
      ) ||
      value.lastActionCatalogVerification.catalogPageToolCounts.reduce(
        (sum, count) => sum + count,
        0,
      ) !== value.lastActionCatalogVerification.catalogToolCount ||
      !/^[a-f0-9]{64}$/.test(value.lastActionCatalogVerification.actionSchemaHash) ||
      !Array.isArray(value.lastActionCatalogVerification.verifiedActionNames) ||
      value.lastActionCatalogVerification.verifiedActionNames.length === 0 ||
      !value.lastActionCatalogVerification.verifiedActionNames.every(
        (name) => typeof name === "string" && name.length > 0,
      ) ||
      new Set(value.lastActionCatalogVerification.verifiedActionNames).size !==
        value.lastActionCatalogVerification.verifiedActionNames.length ||
      (hasAnyNameParityField && !hasValidNameParity) ||
      (actionCatalog?.catalogContractSha256 !== undefined && !hasValidContractParity))
  ) {
    throw new Error("Invalid Oracle action-catalog verification");
  }
  if (
    value.pendingConnectAttempt !== undefined &&
    (!isObject(value.pendingConnectAttempt) ||
      typeof value.pendingConnectAttempt.timestamp !== "string" ||
      typeof value.pendingConnectAttempt.correlationId !== "string" ||
      value.pendingConnectAttempt.correlationId.length === 0 ||
      (value.pendingConnectAttempt.selectorClass !== "accessible-role-name" &&
        value.pendingConnectAttempt.selectorClass !== "bounded-selector-fallback") ||
      !/^[a-f0-9]{64}$/.test(String(value.pendingConnectAttempt.beforeStateHash)) ||
      !/^[a-f0-9]{64}$/.test(String(value.pendingConnectAttempt.clickStateHash)))
  ) {
    throw new Error("Invalid Oracle pending Connect attempt");
  }
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
          (receipt.consentStrength === "connection" ||
            receipt.consentStrength === "low_risk" ||
            receipt.consentStrength === "persistent" ||
            receipt.consentStrength === "full_access") &&
          (receipt.evidenceSource === "settings_reconcile" ||
            receipt.evidenceSource === "conversation_watcher") &&
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
  if (
    value.releasePath !== undefined &&
    (typeof value.releasePath !== "string" || !isAbsolute(value.releasePath))
  ) {
    throw new Error("Invalid OmniCodex daemon release path");
  }
  if (
    value.releaseFingerprint !== undefined &&
    (typeof value.releaseFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.releaseFingerprint))
  ) {
    throw new Error("Invalid OmniCodex daemon release fingerprint");
  }
  const address = value.address === undefined ? undefined : validateDaemonAddress(value.address);
  const tunnel = value.tunnel === undefined ? undefined : validateDaemonTunnel(value.tunnel);
  if (value.tunnelOwnership !== undefined) {
    const ownership = value.tunnelOwnership;
    if (
      !isObject(ownership) ||
      ownership.kind !== "ngrok" ||
      !Number.isInteger(ownership.pid) ||
      (ownership.pid as number) <= 0 ||
      !Number.isInteger(ownership.parentPid) ||
      (ownership.parentPid as number) <= 0 ||
      typeof ownership.processNonce !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(ownership.processNonce) ||
      typeof ownership.executablePath !== "string" ||
      !isAbsolute(ownership.executablePath) ||
      typeof ownership.spawnedAtUnixMs !== "number" ||
      !Number.isSafeInteger(ownership.spawnedAtUnixMs) ||
      typeof ownership.targetUrl !== "string" ||
      typeof ownership.publicUrl !== "string" ||
      typeof ownership.configPath !== "string" ||
      !isAbsolute(ownership.configPath) ||
      ownership.parentPid !== value.pid ||
      (tunnel !== undefined &&
        (tunnel.kind !== "ngrok" ||
          tunnel.pid !== ownership.pid ||
          tunnel.publicUrl !== ownership.publicUrl)) ||
      (address !== undefined && ownership.targetUrl !== `http://127.0.0.1:${String(address.port)}`)
    ) {
      throw new Error("Invalid OmniCodex tunnel ownership state");
    }
  }
  return structuredClone(value as unknown as OmniCodexDaemonState);
}

function validateDaemonAddress(value: unknown): NonNullable<OmniCodexDaemonState["address"]> {
  if (
    !isObject(value) ||
    value.host !== "127.0.0.1" ||
    !Number.isInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    typeof value.fullPath !== "string" ||
    !value.fullPath.startsWith("/") ||
    value.path === value.fullPath
  ) {
    throw new Error("Invalid OmniCodex daemon address");
  }
  return value as unknown as NonNullable<OmniCodexDaemonState["address"]>;
}

function validateDaemonTunnel(value: unknown): NonNullable<OmniCodexDaemonState["tunnel"]> {
  if (
    !isObject(value) ||
    !isTunnelKind(value.kind) ||
    typeof value.publicUrl !== "string" ||
    !Number.isInteger(value.pid) ||
    (value.pid as number) <= 0
  ) {
    throw new Error("Invalid OmniCodex daemon tunnel state");
  }
  return value as unknown as NonNullable<OmniCodexDaemonState["tunnel"]>;
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
  if (tunnel.kind === "oracle_ssh") {
    if (!isAbsolute(tunnel.executablePath)) {
      throw new Error("Oracle SSH tunnel executable must be an absolute path");
    }
    if (!isAbsolute(tunnel.identityFile)) {
      throw new Error("Oracle SSH tunnel identity file must be an absolute path");
    }
    if (
      !isSafeSshHost(tunnel.sshHost) ||
      !/^[A-Za-z0-9._-]{1,64}$/u.test(tunnel.sshUser) ||
      !isTcpPort(tunnel.sshPort) ||
      !isTcpPort(tunnel.remotePort)
    ) {
      throw new Error("Invalid Oracle SSH tunnel endpoint");
    }
  }
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
  return (
    value === "ngrok" ||
    value === "cloudflare" ||
    value === "tailscale" ||
    value === "oracle_ssh" ||
    value === "direct"
  );
}

function isSafeSshHost(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 253 && !/[\s/@\\]/u.test(value)
  );
}

function isTcpPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}
