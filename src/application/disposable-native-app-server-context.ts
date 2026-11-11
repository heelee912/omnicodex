import type { RuntimeCandidate } from "../domain/runtime.js";
import { CodexAppServerConnection } from "../infrastructure/runtime/codex-app-server-connection.js";
import type { CodexAppServerProcessOptions } from "../infrastructure/runtime/codex-app-server-process.js";
import { isTransportTermination } from "../infrastructure/runtime/restartable-codex-app-server-process.js";
import {
  type AppServerRpcClient,
  NativeToolExecutor,
  type NativeToolExecutorOptions,
} from "./native-tool-catalog.js";

export interface OmniCodexSessionNativeRuntime {
  readonly nativeToolExecutor: NativeToolExecutor;
  close(): Promise<void>;
}

interface DisposableNativeAppServerProcess {
  readonly client: AppServerRpcClient;
  start(): Promise<void>;
  stop(): Promise<void>;
  hasAppServerExited?(): boolean;
}

export interface DisposableNativeAppServerContextOptions {
  readonly candidate: RuntimeCandidate;
  readonly processOptions?: CodexAppServerProcessOptions;
  readonly executorOptions?: NativeToolExecutorOptions;
  /** Selects the App Server transport owned by this native context. */
  readonly processFactory?: (
    candidate: RuntimeCandidate,
    options: CodexAppServerProcessOptions,
  ) => DisposableNativeAppServerProcess;
}

/**
 * Opens one App Server transport for a session native execution context.
 * The session lease owns replacement; this context never replays a failed call.
 */
export async function createDisposableNativeAppServerContext(
  options: DisposableNativeAppServerContextOptions,
  signal: AbortSignal,
): Promise<OmniCodexSessionNativeRuntime> {
  throwIfAborted(signal);
  const process = (options.processFactory ?? defaultProcessFactory)(
    options.candidate,
    options.processOptions ?? {},
  );
  let abortStop: Promise<void> | undefined;
  const stopForAbort = () => {
    abortStop ??= process.stop();
    void abortStop.catch(() => undefined);
  };
  signal.addEventListener("abort", stopForAbort, { once: true });
  try {
    await process.start();
    if (signal.aborted) {
      await (abortStop ?? process.stop());
      throw abortReason(signal);
    }
    const nativeToolExecutor = new NativeToolExecutor(process.client, options.executorOptions);
    let closePromise: Promise<void> | undefined;
    let closed = false;
    return {
      nativeToolExecutor,
      close: () => {
        if (closed) return Promise.resolve();
        closePromise ??= (async () => {
          try {
            await nativeToolExecutor.retireOwnedExecutionThread();
          } catch (error) {
            // A dead Desktop process cannot retain its ephemeral threads. A lost
            // socket alone is insufficient evidence: keep its cleanup retryable.
            if (
              !(error instanceof Error) ||
              !isTransportTermination(error) ||
              process.hasAppServerExited?.() !== true
            ) {
              throw error;
            }
          }
          await process.stop();
          nativeToolExecutor.clearOwnedExecutionThreadAfterProcessStop();
          closed = true;
        })().finally(() => {
          closePromise = undefined;
        });
        return closePromise;
      },
    };
  } catch (error) {
    try {
      await (abortStop ?? process.stop());
    } catch (cleanupError) {
      throw new AggregateError(
        [toError(error), toError(cleanupError)],
        "Disposable native App Server startup and cleanup failed",
      );
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", stopForAbort);
  }
}

function defaultProcessFactory(
  candidate: RuntimeCandidate,
  options: CodexAppServerProcessOptions,
): DisposableNativeAppServerProcess {
  return new CodexAppServerConnection(candidate, options);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  const error = new Error(
    reason instanceof Error ? reason.message : String(reason ?? "Cancelled"),
    {
      cause: reason,
    },
  );
  error.name = "AbortError";
  return error;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
