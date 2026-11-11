import type { RuntimeCandidate } from "../domain/runtime.js";
import { CodexAppServerConnection } from "../infrastructure/runtime/codex-app-server-connection.js";
import type { CodexAppServerProcessOptions } from "../infrastructure/runtime/codex-app-server-process.js";
import type { JsonObject } from "../infrastructure/runtime/jsonl-rpc-client.js";
import type { AppServerRpcClient } from "./native-tool-catalog.js";

interface SharedProcess {
  readonly client: AppServerRpcClient;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SharedResponsesBinding {
  ownsThread(threadId: unknown): boolean;
  onNotification(message: JsonObject): void;
  onServerRequest(message: JsonObject): Promise<unknown> | unknown;
  onExit(error: Error): void;
}

export interface SharedResponsesLease {
  readonly process: { readonly client: AppServerRpcClient; stop(): Promise<void> };
  release(): Promise<void>;
}

interface Generation {
  readonly process: SharedProcess;
  readonly bindings: Set<SharedResponsesBinding>;
  readonly started: Promise<void>;
  stopped?: Promise<void> | undefined;
}

/** One shared transport generation, native thread-local state per owner. */
export class SharedResponsesAppServer {
  #generation: Generation | undefined;

  constructor(
    private readonly candidate: RuntimeCandidate,
    private readonly options: CodexAppServerProcessOptions,
    private readonly processFactory = (
      runtime: RuntimeCandidate,
      settings: CodexAppServerProcessOptions,
    ): SharedProcess => new CodexAppServerConnection(runtime, settings),
  ) {}

  async acquire(binding: SharedResponsesBinding): Promise<SharedResponsesLease> {
    if (this.#generation?.stopped !== undefined) await this.#generation.stopped;
    this.#generation ??= this.#createGeneration();
    const generation = this.#generation;
    generation.bindings.add(binding);
    let released = false;
    const release = async () => {
      if (released) return;
      generation.bindings.delete(binding);
      if (generation.bindings.size === 0) await this.#stop(generation);
      released = true;
    };
    try {
      await generation.started;
      return {
        process: {
          get client() {
            return generation.process.client;
          },
          stop: async () => {
            // An uninterruptible native turn invalidates this exact generation.
            // Every owner must observe that loss; no outstanding call is replayed.
            const error = new Error(
              "Responses App Server generation stopped after an uninterruptible turn",
            );
            for (const owner of generation.bindings) owner.onExit(error);
            await this.#stop(generation);
          },
        },
        release,
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  #createGeneration(): Generation {
    const bindings = new Set<SharedResponsesBinding>();
    const process = this.processFactory(this.candidate, {
      ...this.options,
      onNotification: (message) => {
        const params = message.params;
        const threadId =
          params !== null && typeof params === "object"
            ? Reflect.get(params, "threadId")
            : undefined;
        for (const binding of bindings) {
          if (threadId === undefined || binding.ownsThread(threadId))
            binding.onNotification(message);
        }
        this.options.onNotification?.(message);
      },
      onServerRequest: (message) => {
        const params = message.params;
        const threadId =
          params !== null && typeof params === "object" && !Array.isArray(params)
            ? Reflect.get(params, "threadId")
            : undefined;
        const owner = [...bindings].find((binding) => binding.ownsThread(threadId));
        if (owner !== undefined) return owner.onServerRequest(message);
        return this.options.onServerRequest?.(message);
      },
      onUnexpectedExit: (error) => {
        for (const binding of bindings) binding.onExit(error);
        this.options.onUnexpectedExit?.(error);
        void this.#stop(generation).catch(() => undefined);
      },
    });
    const generation: Generation = {
      process,
      bindings,
      started: Promise.resolve().then(() => process.start()),
    };
    return generation;
  }

  async #stop(generation: Generation): Promise<void> {
    generation.stopped ??= generation.process
      .stop()
      .then(() => {
        if (this.#generation === generation) this.#generation = undefined;
      })
      .catch((error: unknown) => {
        generation.stopped = undefined;
        throw error;
      });
    await generation.stopped;
  }
}
