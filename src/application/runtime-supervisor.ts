import type { RuntimeCandidate, RuntimeDiscoveryReport, RuntimeStatus } from "../domain/runtime.js";
import { CodexAppServerProcess } from "../infrastructure/runtime/codex-app-server-process.js";
import type { JsonlRpcClient } from "../infrastructure/runtime/jsonl-rpc-client.js";
import { CodexRuntimeDiscovery } from "../infrastructure/windows/codex-runtime-discovery.js";
import { answerAppServerApprovalRequest } from "./app-server-request-handler.js";

export interface RuntimeStartSafetyGate {
  /** Must fail closed before OmniCodex starts a child process. */
  assertSafeToStart(): Promise<void>;
}

export interface RuntimeDiscoverySource {
  discover(): Promise<RuntimeDiscoveryReport>;
}

export interface RuntimeProcess {
  readonly identity: {
    readonly candidate: RuntimeCandidate;
    readonly pid: number | undefined;
    readonly correlationId: string;
  };
  readonly client: JsonlRpcClient;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeSupervisorOptions {
  readonly discovery?: RuntimeDiscoverySource;
  readonly safetyGate: RuntimeStartSafetyGate;
  readonly processFactory?: (candidate: RuntimeCandidate) => RuntimeProcess;
}

/**
 * Supervises only OmniCodex-owned App Server children. Discovery remains
 * read-only and can be used by diagnostics without establishing a runtime.
 */
export class RuntimeSupervisor {
  readonly #discovery: RuntimeDiscoverySource;
  readonly #safetyGate: RuntimeStartSafetyGate;
  readonly #processFactory: (candidate: RuntimeCandidate) => RuntimeProcess;
  #process: RuntimeProcess | undefined;
  #report: RuntimeDiscoveryReport | undefined;
  #status: RuntimeStatus = { lifecycle: "stopped" };

  constructor(options: RuntimeSupervisorOptions) {
    this.#discovery = options.discovery ?? new CodexRuntimeDiscovery();
    this.#safetyGate = options.safetyGate;
    this.#processFactory =
      options.processFactory ??
      ((candidate) =>
        new CodexAppServerProcess(candidate, {
          onServerRequest: answerAppServerApprovalRequest,
        }));
  }

  get status(): RuntimeStatus {
    return this.#status;
  }

  get discoveryReport(): RuntimeDiscoveryReport | undefined {
    return this.#report;
  }

  async discover(): Promise<RuntimeDiscoveryReport> {
    this.#status = { lifecycle: "discovering" };
    this.#report = await this.#discovery.discover();
    this.#status = { lifecycle: "stopped" };
    return this.#report;
  }

  async start(): Promise<RuntimeStatus> {
    if (this.#process !== undefined) {
      return this.#status;
    }
    await this.#safetyGate.assertSafeToStart();
    const report = this.#report ?? (await this.discover());
    const failures: string[] = [];
    this.#status = { lifecycle: "starting" };

    for (const candidate of report.candidates) {
      const process = this.#processFactory(candidate);
      try {
        await process.start();
        this.#process = process;
        const identity = process.identity;
        this.#status = {
          lifecycle: "ready",
          candidate,
          ...(identity.pid === undefined ? {} : { pid: identity.pid }),
          correlationId: identity.correlationId,
          initializedAtUnixMs: Date.now(),
        };
        return this.#status;
      } catch (error) {
        failures.push(`${candidate.canonicalPath}: ${toError(error).message}`);
        await process.stop();
      }
    }

    const message =
      failures.length > 0 ? failures.join("; ") : "No Codex runtime candidate was found";
    this.#status = { lifecycle: "failed", lastError: message };
    throw new Error(message);
  }

  async stop(): Promise<void> {
    const process = this.#process;
    if (process === undefined) {
      this.#status = { lifecycle: "stopped" };
      return;
    }
    this.#status = { ...this.#status, lifecycle: "draining" };
    this.#process = undefined;
    await process.stop();
    this.#status = { lifecycle: "stopped" };
  }

  get client() {
    if (this.#process === undefined) {
      throw new Error("Codex runtime is not ready");
    }
    return this.#process.client;
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
