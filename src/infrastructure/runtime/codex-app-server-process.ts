import { randomUUID } from "node:crypto";
import type { RuntimeCandidate } from "../../domain/runtime.js";
import {
  HiddenChildProcessBoundary,
  type RecoveredWindowsProcessIdentity,
  spawnHidden,
  terminateOwnedHiddenChild,
} from "../windows/hidden-child-process.js";
import { JsonlRpcClient, type JsonObject } from "./jsonl-rpc-client.js";
import type {
  CodexAppServerOwnershipRegistry,
  CodexAppServerRegistration,
} from "./owned-codex-app-server-registry.js";

export interface CodexAppServerProcessOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Process-local Codex `-c` overrides. Never persists to the user's config. */
  readonly configOverrides?: readonly string[];
  readonly correlationId?: string;
  /** Optional lifecycle deadline for the startup `initialize` request only. */
  readonly requestTimeoutMs?: number;
  readonly onNotification?: (message: JsonObject) => void;
  readonly onServerRequest?: (message: JsonObject) => Promise<unknown> | unknown;
  readonly onUnexpectedExit?: (error: Error) => Promise<void> | void;
  readonly initializeCapabilities?: Record<string, unknown>;
  /** Durable exact-process registry used by the daemon crash-recovery path. */
  readonly ownershipRegistry?: CodexAppServerOwnershipRegistry;
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
  #diagnostic = "";
  #stopping = false;
  #unexpectedExitReported = false;
  #registration: CodexAppServerRegistration | undefined;
  #registrationRelease: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #childCloseConfirmed = false;
  readonly #processBoundary = new HiddenChildProcessBoundary();
  #ownedConsoles: RecoveredWindowsProcessIdentity[] = [];
  #consoleCapture: Promise<void> | undefined;

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
    this.#diagnostic = "";
    this.#stopping = false;
    this.#unexpectedExitReported = false;
    this.#childCloseConfirmed = false;
    const configArgs = (this.#options.configOverrides ?? []).flatMap((value) => ["-c", value]);
    const launchArgs = [
      "app-server",
      "--stdio",
      ...configArgs,
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ];
    const spawnStartedAt = Date.now();
    const child = spawnHidden(this.#candidate.executablePath, launchArgs, {
      cwd: this.#options.cwd,
      env: {
        // Native command output is UTF-8. Python otherwise uses the Windows
        // locale for pipes (e.g. cp949), which cannot print some source text.
        // Explicit inherited or per-runtime settings still take precedence.
        ...(process.platform === "win32" ? { PYTHONIOENCODING: "utf-8" } : {}),
        ...process.env,
        ...this.#options.env,
        // Only the scheduled launcher owns this supervisor role. Native tool
        // children must not turn ordinary CLI starts into long-lived supervisors.
        OMNICODEX_AUTOSTART_SOURCE: undefined,
        OMNICODEX_RUNTIME_CHILD: "1",
        OMNICODEX_CORRELATION_ID: this.#correlationId,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#diagnostic += redactDiagnostic(chunk.toString());
      this.#options.onNotification?.({
        method: "omnicodex/runtime/stderr",
        params: { text: chunk.toString() },
      });
    });
    child.once("error", (error) => {
      this.#client?.close(error);
      this.#reportUnexpectedExit(
        new Error(`Codex App Server process error${diagnosticSuffix(this.#diagnostic)}`, {
          cause: error,
        }),
      );
    });
    child.once("exit", (code, signal) => {
      // A descendant can keep a copied stdout handle open after this exact
      // process exits. Recovery must start from process exit, not stdio close.
      const error = new Error(
        `Codex App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"})${diagnosticSuffix(this.#diagnostic)}`,
      );
      this.#client?.close(error);
      this.#reportUnexpectedExit(error);
    });
    child.once("close", (code, signal) => {
      if (this.#child === child) this.#childCloseConfirmed = true;
      const error = new Error(
        `Codex App Server exited (code=${code ?? "null"}, signal=${signal ?? "null"})${diagnosticSuffix(this.#diagnostic)}`,
      );
      this.#client?.close(error);
      this.#reportUnexpectedExit(error);
      void this.#releaseRegistrationAfterConfirmedExit().catch((cleanupError) => {
        this.#options.onNotification?.({
          method: "omnicodex/runtime/ownershipRegistryCleanupFailed",
          params: { message: toError(cleanupError).message },
        });
      });
    });

    if (this.#options.ownershipRegistry !== undefined) {
      try {
        this.#registration = await this.#options.ownershipRegistry.register({
          child,
          candidate: this.#candidate,
          launchArgs,
        });
      } catch (error) {
        const registrationFailure = new Error(
          `Codex App Server ownership registration failed: ${toError(error).message}`,
          { cause: error },
        );
        this.#stopping = true;
        try {
          await terminateOwnedAppServerChildAndWait(child, {
            isCloseConfirmed: () => this.#child === child && this.#childCloseConfirmed,
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [registrationFailure, toError(cleanupError)],
            "Codex App Server ownership registration and exact child cleanup both failed",
          );
        }
        if (this.#child === child) this.#child = undefined;
        throw registrationFailure;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const earlyExitFailure = new Error("Codex App Server exited during ownership registration");
        this.#stopping = true;
        try {
          await terminateOwnedAppServerChildAndWait(child, {
            isCloseConfirmed: () => this.#child === child && this.#childCloseConfirmed,
          });
        } catch (cleanupError) {
          throw new AggregateError(
            [earlyExitFailure, toError(cleanupError)],
            "Codex App Server exited during registration without a confirmed stdio close",
          );
        }
        await this.#releaseRegistrationAfterConfirmedExit();
        if (this.#child === child) this.#child = undefined;
        throw earlyExitFailure;
      }
    }

    if (child.stdin === null || child.stdout === null) {
      await this.stop();
      throw new Error("Codex App Server did not expose stdio pipes");
    }
    this.#client = new JsonlRpcClient({
      readable: child.stdout,
      writable: child.stdin,
      ...(this.#options.onNotification === undefined
        ? {}
        : { onNotification: this.#options.onNotification }),
      ...(this.#options.onServerRequest === undefined
        ? {}
        : { onServerRequest: this.#options.onServerRequest }),
    });
    try {
      await this.#client.request(
        "initialize",
        {
          clientInfo: {
            name: "omnicodex",
            version: "0.0.0-development",
          },
          capabilities: this.#options.initializeCapabilities ?? {
            experimentalApi: true,
            extensions: {},
          },
        },
        this.#options.requestTimeoutMs,
      );
      this.#consoleCapture = this.#captureOwnedConsoles(child, spawnStartedAt);
      await this.#consoleCapture;
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [toError(error), toError(cleanupError)],
          "Codex App Server initialization and exact child cleanup both failed",
        );
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const operation = this.#stop().finally(() => {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    });
    this.#stopPromise = operation;
    return operation;
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    if (child === undefined) {
      return;
    }
    this.#client?.close();
    this.#client = undefined;
    // A concurrent stop must let the live-parent observation finish before EOF.
    // Inspection failure must not prevent termination of the owned server itself.
    await this.#consoleCapture?.catch(() => undefined);
    if (this.#childCloseConfirmed) {
      await this.#releaseOwnedConsoles();
      await this.#releaseRegistrationAfterConfirmedExit();
      if (this.#child === child) this.#child = undefined;
      return;
    }
    await terminateOwnedAppServerChildAndWait(child, {
      isCloseConfirmed: () => this.#child === child && this.#childCloseConfirmed,
    });
    await this.#releaseOwnedConsoles();
    await this.#releaseRegistrationAfterConfirmedExit();
    if (this.#child === child) this.#child = undefined;
  }

  async #captureOwnedConsoles(
    child: ReturnType<typeof spawnHidden>,
    spawnStartedAt: number,
  ): Promise<void> {
    if (process.platform !== "win32" || child.pid === undefined) return;
    if (this.#childCloseConfirmed || ownedChildProcessExited(child)) return;
    const consoles = await this.#processBoundary.inspectWindowsProcessesByName("conhost.exe");
    // A live parent handle prevents attribution through a recycled parent PID.
    if (this.#child !== child || this.#childCloseConfirmed || ownedChildProcessExited(child))
      return;
    this.#ownedConsoles = consoles.filter(
      (console) =>
        console.parentPid === child.pid &&
        console.name.toLowerCase() === "conhost.exe" &&
        Date.parse(console.startedAtIso) >= spawnStartedAt &&
        Date.parse(console.startedAtIso) <= Date.now(),
    );
  }

  async #releaseOwnedConsoles(): Promise<void> {
    for (const console of [...this.#ownedConsoles]) {
      // The existing boundary rechecks PID, parent, creation time, executable and
      // command line. An absent or recycled PID is never signaled.
      await this.#processBoundary.terminateExactRecoveredWindowsProcess(console);
      this.#ownedConsoles = this.#ownedConsoles.filter((owned) => owned !== console);
    }
    this.#consoleCapture = undefined;
  }

  async #releaseRegistrationAfterConfirmedExit(): Promise<void> {
    if (this.#registrationRelease !== undefined) return this.#registrationRelease;
    const registration = this.#registration;
    if (registration === undefined) return;
    const operation = registration
      .releaseAfterConfirmedExit()
      .then(() => {
        if (this.#registration === registration) this.#registration = undefined;
      })
      .finally(() => {
        if (this.#registrationRelease === operation) this.#registrationRelease = undefined;
      });
    this.#registrationRelease = operation;
    return operation;
  }

  #reportUnexpectedExit(error: Error): void {
    if (this.#stopping || this.#unexpectedExitReported) return;
    this.#unexpectedExitReported = true;
    queueMicrotask(() => {
      // Start the callback from an already-resolved promise so a synchronous
      // throw from a lifecycle observer is contained by the same rejection
      // boundary as an asynchronously rejected observer.  An early child exit
      // can occur before `client` exists; that recovery race must never escape
      // the owned runtime and take down the public OmniCodex daemon.
      void Promise.resolve()
        .then(() => this.#options.onUnexpectedExit?.(error))
        .catch(() => undefined);
    });
  }
}

export async function terminateOwnedAppServerChildAndWait(
  child: ReturnType<typeof spawnHidden>,
  options: {
    readonly gracefulWaitMs?: number;
    readonly forceWaitMs?: number;
    readonly terminate?: typeof terminateOwnedHiddenChild;
    readonly isCloseConfirmed?: () => boolean;
  } = {},
): Promise<void> {
  if (options.isCloseConfirmed?.() === true) return;
  const terminate = options.terminate ?? terminateOwnedHiddenChild;
  if (!ownedChildProcessExited(child) && child.stdin?.writable && !child.stdin.destroyed) {
    // On Windows SIGTERM kills the process immediately. Give the stdio server
    // EOF first so it can shut down its own MCP/REPL children before exiting.
    const closed = waitForOwnedChildClose(
      child,
      options.gracefulWaitMs ?? 2_000,
      options.isCloseConfirmed,
    );
    child.stdin.end();
    if (await closed) return;
  }
  if (child.exitCode === null && child.signalCode === null) terminate(child);
  if (
    await waitForOwnedChildClose(child, options.gracefulWaitMs ?? 2_000, options.isCloseConfirmed)
  ) {
    return;
  }
  if (ownedChildProcessExited(child)) {
    disposeExitedOwnedChildPipes(child);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) terminate(child, "SIGKILL");
  if (await waitForOwnedChildClose(child, options.forceWaitMs ?? 2_000, options.isCloseConfirmed)) {
    return;
  }
  if (ownedChildProcessExited(child)) {
    disposeExitedOwnedChildPipes(child);
    return;
  }
  throw new Error("Codex App Server did not emit close after exact owned-child termination");
}

function ownedChildProcessExited(child: ReturnType<typeof spawnHidden>): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Windows can report the exact owned process exit while a duplicated stdio
 * handle delays or suppresses Node's later `close` event.  Once the process
 * exit itself is authoritative, dispose only this parent's pipe handles so a
 * dead child cannot make the next runtime generation fail or keep the daemon
 * event loop alive.  Never use pipe disposal as evidence that a live process
 * stopped.
 */
function disposeExitedOwnedChildPipes(child: ReturnType<typeof spawnHidden>): void {
  const streams = new Set(
    [child.stdin, child.stdout, child.stderr, ...(child.stdio ?? [])].filter(
      (stream): stream is NonNullable<typeof stream> => stream !== null && stream !== undefined,
    ),
  );
  for (const stream of streams) {
    if ("destroy" in stream && typeof stream.destroy === "function" && !stream.destroyed) {
      stream.destroy();
    }
  }
}

function waitForOwnedChildClose(
  child: ReturnType<typeof spawnHidden>,
  timeoutMs: number,
  isCloseConfirmed: (() => boolean) | undefined,
): Promise<boolean> {
  if (isCloseConfirmed?.() === true) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolveExit(exited);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    if (isCloseConfirmed?.() === true) finish(true);
  });
}

function redactDiagnostic(value: string): string {
  return value
    .replaceAll(
      /((?:token|secret|authorization|password|api[_-]?key))['"=:\s]+[^\s,"'}]+/gi,
      "$1=[redacted]",
    )
    .replaceAll(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replaceAll(/(?:eyJ[A-Za-z0-9._~-]{16,}|[A-Za-z0-9_-]{40,})/g, "[redacted]");
}

function diagnosticSuffix(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length === 0 ? "" : `: ${normalized}`;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
