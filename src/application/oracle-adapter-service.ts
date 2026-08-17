import { randomUUID } from "node:crypto";
import {
  type ApprovalWatchResult,
  assertExplicitLoopbackCdpEndpoint,
  ChatGptAppApprovalAdapter,
  type ChatGptApprovalSurface,
} from "../infrastructure/chatgpt/chatgpt-app-approval-adapter.js";
import {
  loadOmniCodexConfig,
  type OmniCodexConfig,
  type OmniCodexOracleConfig,
  saveOmniCodexConfig,
} from "../infrastructure/config/omnicodex-config-store.js";
export interface OracleSetupInput {
  readonly connectorId: string;
  readonly connectorName: string;
  readonly runId: string;
  readonly resource: string;
  readonly surface: "/mcp" | "/mcp/full";
  readonly cdpEndpoint: string;
}
export class OracleAdapterService {
  readonly #load: () => Promise<OmniCodexConfig>;
  readonly #save: (c: OmniCodexConfig) => Promise<void>;
  constructor(
    ports: {
      load?: () => Promise<OmniCodexConfig>;
      save?: (c: OmniCodexConfig) => Promise<void>;
    } = {},
  ) {
    this.#load = ports.load ?? (() => loadOmniCodexConfig());
    this.#save = ports.save ?? ((c) => saveOmniCodexConfig(c));
  }
  async setup(
    input: OracleSetupInput,
    execute = false,
  ): Promise<{ executed: boolean; oracle: OmniCodexOracleConfig }> {
    assertExplicitLoopbackCdpEndpoint(input.cdpEndpoint);
    if (new URL(input.resource).protocol !== "https:")
      throw new Error("Oracle resource must use HTTPS");
    for (const value of [input.connectorId, input.connectorName, input.runId])
      if (value.trim() === "") throw new Error("Exact Oracle binding values are required");
    const oracle: OmniCodexOracleConfig = {
      enabled: true,
      connectorId: input.connectorId,
      connectorName: input.connectorName,
      runId: input.runId,
      resource: input.resource,
      surface: input.surface,
      cdpEndpoint: input.cdpEndpoint,
      freshLiveVerification: "pending",
    };
    if (execute) {
      const config = await this.#load();
      await this.#save({ ...config, oracle });
      const readback = await this.#load();
      if (JSON.stringify(readback.oracle) !== JSON.stringify(oracle))
        throw new Error("Oracle config authoritative readback failed");
    }
    return { executed: execute, oracle };
  }
  async status() {
    const oracle = (await this.#load()).oracle;
    return {
      enabled: oracle?.enabled === true,
      complete:
        oracle !== undefined &&
        [
          oracle.connectorId,
          oracle.connectorName,
          oracle.runId,
          oracle.resource,
          oracle.surface,
          oracle.cdpEndpoint,
        ].every((v) => v.length > 0),
      cdpEndpointValid: oracle === undefined ? false : safeEndpoint(oracle.cdpEndpoint),
      freshLiveVerification: oracle?.freshLiveVerification ?? "pending",
      lastReceipts: oracle?.lastReceipts ?? [],
      config: oracle === undefined ? null : { ...oracle, lastReceipts: undefined },
    };
  }
  async test(
    surface: ChatGptApprovalSurface,
    execute = false,
    identity: { sessionId?: string; correlationId?: string } = {},
  ): Promise<ApprovalWatchResult> {
    const config = await this.#load();
    const o = config.oracle;
    if (o?.enabled !== true) throw new Error("Oracle adapter is disabled");
    const binding = {
      appConnectorId: o.connectorId,
      appName: o.connectorName,
      oracleRunId: o.runId,
      sessionId: identity.sessionId ?? o.runId,
      correlationId: identity.correlationId ?? randomUUID(),
      mcpServerResource: o.resource,
      mcpSurface: o.surface,
    };
    const result = await new ChatGptAppApprovalAdapter(binding).watch(surface, {
      dryRun: !execute,
    });
    if (execute) {
      const actions = new Set(result.receipts.map((receipt) => receipt.action));
      if (
        result.state !== "tool_result" ||
        !actions.has("connect") ||
        !actions.has("always_allow")
      ) {
        throw new Error("ORACLE_REQUIRED_CONSENT_SEQUENCE_NOT_OBSERVED");
      }
      const lastReceipts = result.receipts.slice(-2).map((receipt) => ({
        timestamp: receipt.timestamp,
        action: receipt.action,
        correlationId: receipt.correlationId,
        beforeStateHash: receipt.beforeStateHash,
        afterStateHash: receipt.afterStateHash,
      }));
      await this.#save({
        ...config,
        oracle: { ...o, lastReceipts, freshLiveVerification: "verified" },
      });
    }
    return result;
  }
  async disable(execute = false) {
    const config = await this.#load();
    if (!execute) return { executed: false, enabled: false };
    if (config.oracle === undefined) return { executed: true, enabled: false };
    await this.#save({ ...config, oracle: { ...config.oracle, enabled: false } });
    const readback = await this.#load();
    if (readback.oracle?.enabled !== false) throw new Error("Oracle disable readback failed");
    return { executed: true, enabled: false };
  }
}
function safeEndpoint(value: string): boolean {
  try {
    assertExplicitLoopbackCdpEndpoint(value);
    return true;
  } catch {
    return false;
  }
}
