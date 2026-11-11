import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { RuntimeCandidate } from "../../domain/runtime.js";
import type {
  CodexAppServerIdentity,
  CodexAppServerProcessOptions,
} from "./codex-app-server-process.js";
import {
  type DesktopAppServerEndpoint,
  DesktopAppServerLocator,
} from "./desktop-app-server-locator.js";
import { JsonlRpcClient } from "./jsonl-rpc-client.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

/** A client connection to the Desktop-owned app-server; stop closes only its socket. */
export class CodexAppServerConnection {
  readonly #candidate: RuntimeCandidate;
  readonly #options: CodexAppServerProcessOptions;
  readonly #locator: Pick<DesktopAppServerLocator, "locate">;
  readonly #correlationId: string;
  #endpoint: DesktopAppServerEndpoint | undefined;
  #socket: Socket | undefined;
  #client: JsonlRpcClient | undefined;
  #stopping = false;

  constructor(
    candidate: RuntimeCandidate,
    options: CodexAppServerProcessOptions = {},
    locator: Pick<DesktopAppServerLocator, "locate"> = new DesktopAppServerLocator({
      expectedExecutablePath: candidate.executablePath,
    }),
  ) {
    this.#candidate = candidate;
    this.#options = options;
    this.#locator = locator;
    this.#correlationId = options.correlationId ?? randomUUID();
  }

  get identity(): CodexAppServerIdentity {
    return {
      candidate: this.#candidate,
      pid: this.#endpoint?.pid,
      correlationId: this.#correlationId,
      ownershipNonce: undefined,
      spawnedAtUnixMs: undefined,
    };
  }

  get client(): JsonlRpcClient {
    if (this.#client === undefined) throw new Error("Desktop app-server pipe is not connected");
    return this.#client;
  }

  /** A reused PID is treated as alive; only a confirmed missing PID is considered exited. */
  hasAppServerExited(): boolean {
    const pid = this.#endpoint?.pid;
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "code") === "ESRCH") return true;
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.#socket !== undefined) throw new Error("Desktop app-server pipe is already connected");
    this.#stopping = false;
    const endpoint = await this.#locator.locate();
    if (
      this.#candidate.productVersion !== undefined &&
      endpoint.appServerVersion !== this.#candidate.productVersion
    ) {
      throw new Error("Desktop app-server version differs from the selected engine");
    }
    try {
      const socket = connect(endpoint.pipeName);
      this.#socket = socket;
      await waitForPipeConnection(
        socket,
        this.#options.requestTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
      socket.once("close", () => this.#reportDisconnection(endpoint.pid));
      if (this.#stopping) throw new Error("Desktop app-server pipe connection was stopped");
      this.#endpoint = endpoint;
      this.#client = new JsonlRpcClient({
        readable: socket,
        writable: socket,
        ...(this.#options.onNotification === undefined
          ? {}
          : { onNotification: this.#options.onNotification }),
        ...(this.#options.onServerRequest === undefined
          ? {}
          : { onServerRequest: this.#options.onServerRequest }),
      });
      const initialized = await this.#client.request<{ codexHome?: string }>(
        "initialize",
        {
          clientInfo: {
            name: "omnicodex",
            version: "0.0.0-development",
          },
          capabilities: {
            experimentalApi: true,
            ...this.#options.initializeCapabilities,
            extensions: {
              ...objectValue(this.#options.initializeCapabilities?.extensions),
              "omnicodex/thread-owner-key": endpoint.instanceNonce,
            },
          },
        },
        this.#options.requestTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      );
      if (typeof initialized.codexHome !== "string" || initialized.codexHome.length === 0) {
        throw new Error("Desktop app-server initialize response omitted codexHome");
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#client?.close();
    this.#client = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#endpoint = undefined;
  }

  #reportDisconnection(pid: number): void {
    if (this.#stopping) return;
    try {
      void Promise.resolve(
        this.#options.onUnexpectedExit?.(
          new Error(`Desktop app-server connection disconnected (pid=${pid})`),
        ),
      ).catch(() => undefined);
    } catch {
      // The restartable client also observes its closed RPC stream.
    }
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function waitForPipeConnection(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`Desktop app-server pipe did not connect within ${timeoutMs}ms`));
    }, timeoutMs);
    const connected = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => {
      cleanup();
      reject(new Error("Desktop app-server pipe closed before connection"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", connected);
      socket.off("error", failed);
      socket.off("close", closed);
    };
    socket.once("connect", connected);
    socket.once("error", failed);
    socket.once("close", closed);
  });
}
