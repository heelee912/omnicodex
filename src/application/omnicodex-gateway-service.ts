import type { IncomingMessage } from "node:http";
import type { RuntimeCandidate } from "../domain/runtime.js";
import {
  type HttpAuthorizationDecision,
  StreamableHttpGateway,
  type StreamableHttpGatewayAddress,
} from "../infrastructure/mcp/streamable-http-gateway.js";
import { CodexAppServerProcess } from "../infrastructure/runtime/codex-app-server-process.js";
import { CodexSchemaBundleLoader } from "../infrastructure/runtime/codex-schema-bundle-loader.js";
import type { JsonObject } from "../infrastructure/runtime/jsonl-rpc-client.js";
import { CodexRuntimeDiscovery } from "../infrastructure/windows/codex-runtime-discovery.js";
import { AppServerMethodCatalog } from "./app-server-method-catalog.js";
import { answerAppServerApprovalRequest } from "./app-server-request-handler.js";
import { BrowserNativeExecutor } from "./browser-native-executor.js";
import { CodexHostToolAdapter } from "./codex-host-tool-adapter.js";
import { ComputerUseNativeExecutor } from "./computer-use-native-executor.js";
import { NativeToolCatalog } from "./native-tool-catalog.js";
import {
  ResponsesNativeToolCatalog,
  ResponsesNativeToolExecutor,
} from "./responses-native-tool-catalog.js";
import { ResponsesRuntimeExecutor } from "./responses-runtime-executor.js";

export type OmniCodexGatewayLifecycle = "stopped" | "starting" | "ready" | "stopping" | "failed";

export interface OmniCodexGatewayStatus {
  readonly lifecycle: OmniCodexGatewayLifecycle;
  readonly candidate?: RuntimeCandidate;
  readonly address?: StreamableHttpGatewayAddress;
  readonly appServerMethodCount?: number;
  readonly downstreamToolCount?: number;
  readonly responsesToolCount?: number;
  readonly hostToolCount?: number;
  readonly lastError?: string;
}

export interface OmniCodexGatewayServiceOptions {
  readonly cwd?: string;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly fullPath?: string;
  readonly allowedOrigins?: readonly string[];
  readonly protectedResourceMetadata?: Record<string, unknown>;
  readonly authorize: (
    request: IncomingMessage,
  ) => Promise<HttpAuthorizationDecision> | HttpAuthorizationDecision;
  readonly discovery?: CodexRuntimeDiscovery;
  readonly onDiagnostic?: (message: JsonObject) => void;
}

interface RunningComponents {
  readonly primary: CodexAppServerProcess;
  readonly responses: ResponsesRuntimeExecutor;
  readonly gateway: StreamableHttpGateway;
}

/**
 * Starts only OmniCodex-owned hidden children and binds the MCP listener to
 * loopback. It never attaches to, signals, or reconfigures the desktop app.
 */
export class OmniCodexGatewayService {
  readonly #options: OmniCodexGatewayServiceOptions;
  readonly #discovery: CodexRuntimeDiscovery;
  #components: RunningComponents | undefined;
  #status: OmniCodexGatewayStatus = { lifecycle: "stopped" };
  #transition: Promise<OmniCodexGatewayStatus> | undefined;

  constructor(options: OmniCodexGatewayServiceOptions) {
    if ((options.host ?? "127.0.0.1") !== "127.0.0.1") {
      throw new Error("OmniCodex must bind to 127.0.0.1; use an outbound tunnel for remote access");
    }
    this.#options = options;
    this.#discovery = options.discovery ?? new CodexRuntimeDiscovery();
  }

  get status(): OmniCodexGatewayStatus {
    return this.#status;
  }

  async start(): Promise<OmniCodexGatewayStatus> {
    if (this.#components !== undefined) {
      return this.#status;
    }
    if (this.#transition !== undefined) {
      return this.#transition;
    }
    this.#transition = this.#start();
    try {
      return await this.#transition;
    } finally {
      this.#transition = undefined;
    }
  }

  async stop(): Promise<OmniCodexGatewayStatus> {
    if (this.#transition !== undefined) {
      await this.#transition.catch(() => undefined);
    }
    const components = this.#components;
    if (components === undefined) {
      this.#status = { lifecycle: "stopped" };
      return this.#status;
    }
    this.#status = { ...this.#status, lifecycle: "stopping" };
    this.#components = undefined;
    await components.gateway.stop().catch(() => undefined);
    await components.responses.stop().catch(() => undefined);
    await components.primary.stop().catch(() => undefined);
    this.#status = { lifecycle: "stopped" };
    return this.#status;
  }

  async #start(): Promise<OmniCodexGatewayStatus> {
    this.#status = { lifecycle: "starting" };
    const report = await this.#discovery.discover();
    const failures: string[] = [];

    for (const candidate of report.candidates) {
      const primary = new CodexAppServerProcess(candidate, {
        configOverrides: ["features.code_mode_host=true"],
        requestTimeoutMs: 120_000,
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        ...(this.#options.onDiagnostic === undefined
          ? {}
          : { onNotification: this.#options.onDiagnostic }),
        onServerRequest: answerAppServerApprovalRequest,
      });
      const responses = new ResponsesRuntimeExecutor(candidate, {
        ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
        ...(this.#options.onDiagnostic === undefined
          ? {}
          : { onDiagnostic: this.#options.onDiagnostic }),
      });
      let gateway: StreamableHttpGateway | undefined;
      try {
        await primary.start();

        const methodCatalog = new AppServerMethodCatalog(new CodexSchemaBundleLoader(candidate));
        const downstreamCatalog = new NativeToolCatalog(primary.client);
        await Promise.all([
          methodCatalog.refresh(),
          downstreamCatalog.refresh(),
          responses.start(),
        ]);

        const responsesCatalog = new ResponsesNativeToolCatalog(responses);
        await responsesCatalog.refresh();
        const responsesExecutor = new ResponsesNativeToolExecutor(responses);
        const browserExecutor = new BrowserNativeExecutor(responses);
        const computerUseExecutor = new ComputerUseNativeExecutor(responses);
        const hostToolAdapter = new CodexHostToolAdapter(primary.client, {
          ...(this.#options.cwd === undefined ? {} : { cwd: this.#options.cwd }),
          browser: browserExecutor,
          computerUse: computerUseExecutor,
        });

        gateway = new StreamableHttpGateway({
          appServer: primary.client,
          appServerMethodCatalog: methodCatalog,
          responsesToolCatalog: responsesCatalog,
          responsesToolExecutor: responsesExecutor,
          hostToolAdapter,
          host: "127.0.0.1",
          port: this.#options.port ?? 0,
          path: this.#options.path ?? "/mcp",
          fullPath: this.#options.fullPath ?? "/mcp/full",
          authorize: this.#options.authorize,
          ...(this.#options.allowedOrigins === undefined
            ? {}
            : { allowedOrigins: this.#options.allowedOrigins }),
          ...(this.#options.protectedResourceMetadata === undefined
            ? {}
            : { protectedResourceMetadata: this.#options.protectedResourceMetadata }),
        });
        const address = await gateway.start();
        this.#components = { primary, responses, gateway };
        this.#status = {
          lifecycle: "ready",
          candidate,
          address,
          appServerMethodCount: methodCatalog.snapshot.methods.length,
          downstreamToolCount: downstreamCatalog.snapshot.tools.length,
          responsesToolCount: responsesCatalog.snapshot.tools.length,
          hostToolCount: hostToolAdapter.tools.length,
        };
        return this.#status;
      } catch (error) {
        failures.push(`${candidate.canonicalPath}: ${toError(error).message}`);
        await gateway?.stop().catch(() => undefined);
        await responses.stop().catch(() => undefined);
        await primary.stop().catch(() => undefined);
      }
    }

    const message =
      failures.length > 0
        ? failures.join("; ")
        : `No installed Codex runtime was found${
            report.warnings.length === 0 ? "" : ` (${report.warnings.join("; ")})`
          }`;
    this.#status = { lifecycle: "failed", lastError: message };
    throw new Error(message);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
