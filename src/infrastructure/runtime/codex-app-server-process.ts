import { randomUUID } from "node:crypto";
import type { RuntimeCandidate } from "../../domain/runtime.js";
import { spawnHidden, terminateOwnedHiddenChild } from "../windows/hidden-child-process.js";
import { JsonlRpcClient, type JsonObject } from "./jsonl-rpc-client.js";

export interface CodexAppServerProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Process-local Codex `-c` overrides. Never persists to the user's config. */
  readonly configOverrides?: readonly string[];
  readonly correlationId?: string;
  readonly requestTimeoutMs?: number;
  readonly onNotification?: (message: JsonObject) => void;
  readonly onServerRequest?: (message: JsonObject) => Promise<unknown> | unknown;
  readonly initializeCapabilities?: Record<string, unknown>;
}

export interface CodexAppServerIdentity {
  readonly candidate: RuntimeCandidate;
  readonly pid: number | undefined;
  readonly correlationId: string;
  readonly ownershipNonce: string | undefined;
  readonly spawnedAtUnixMs: number | undefined;
}

/** Owns one child `codex app-server --stdio`; never attaches to the desktop app. */
export class CodexAppServerProcess {
  readonly #candidate: RuntimeCandidate;
  readonly #options: CodexAppServerProcessOptions;
  readonly #correlationId: string;
  #child: ReturnType<typeof spawnHidden> | undefined;
  #client: JsonlRpcClient | undefined;

  constructor(candidate: RuntimeCandidate, options: CodexAppServerProcessOptions = {}) {
    this.#candidate = candidate;
    this.#options = options;
    this.#correlationId = options.correlationId ?? randomUUID();
  }

  get identity(): CodexAppServerIdentity {
    return {
      candidate: this.#candidate,
      pid: this.#child?.pid,
      correlationId: this.#correlationId,
      ownershipNonce: this.#child?.ownership.nonce,
      spawnedAtUnixMs: this.#child?.ownership.spawnedAtUnixMs,
    };
  }

  get client(): JsonlRpcClient {
    if (this.#client === undefined) {
      throw new Error("Codex App Server has not been started");
    }
    return this.#client;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) {
      throw new Error("Codex App Server is already started");
    }
    const configArgs = (this.#options.configOverrides ?? []).flatMap((value) => ["-c", value]);
    const child = spawnHidden(
      this.#candidate.executablePath,
      [
        "app-server",
        "--stdio",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
        ...configArgs,
      ],
      {
        cwd: this.#options.cwd,
        env: {
          ...process.env,
          ...this.#options.env,
          OMNICODEX_RUNTIME_CHILD: "1",
          OMNICODEX_CORRELATION_ID: this.#correlationId,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.#child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#options.onNotification?.({
        method: "omnicodex/runtime/stderr",
        params: { text: chunk.toString() },
      });
    });
    child.once("error", (error) => {
      this.#client?.close(error);
    });
    child.once("close", (code, signal) => {
      this.#client?.close(
        new Error(`Codex App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`),
      );
    });

    if (child.stdin === null || child.stdout === null) {
      await this.stop();
      throw new Error("Codex App Server did not expose stdio pipes");
    }
    this.#client = new JsonlRpcClient({
      readable: child.stdout,
      writable: child.stdin,
      ...(this.#options.requestTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: this.#options.requestTimeoutMs }),
      ...(this.#options.onNotification === undefined
        ? {}
        : { onNotification: this.#options.onNotification }),
      ...(this.#options.onServerRequest === undefined
        ? {}
        : { onServerRequest: this.#options.onServerRequest }),
    });
    await this.#client.request("initialize", {
      clientInfo: {
        name: "omnicodex",
        version: "0.0.0-development",
      },
      capabilities: this.#options.initializeCapabilities ?? {
        experimentalApi: true,
        extensions: {},
      },
    });
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) {
      return;
    }
    this.#client?.close();
    this.#client = undefined;
    this.#child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          terminateOwnedHiddenChild(child);
        }
        resolveStop();
      }, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveStop();
      });
      terminateOwnedHiddenChild(child);
    });
  }
}
