export interface DesktopRuntimeDisconnectionOptions {
  readonly isActive: boolean;
  readonly retireResponses: (error: Error) => Promise<void>;
  readonly retireConnection: () => Promise<void>;
  readonly notifyOwner: (error: Error) => Promise<void> | void;
  readonly reportFailure?: (error: unknown) => void;
}

/** Bounds retry frequency while Desktop is still restarting. */
export function desktopRuntimeRecoveryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Desktop runtime recovery attempt must be a positive integer");
  }
  return Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
}

export interface DesktopRuntimeRecoveryOptions {
  readonly isStopping: () => boolean;
  readonly wait: (delayMs: number) => Promise<void>;
  readonly recover: (attempt: number) => Promise<void>;
  readonly onFailure: (error: unknown, attempt: number) => Promise<void>;
}

/** Keeps rediscovering Desktop until a recovery succeeds or the service stops. */
export async function recoverDesktopRuntimeUntilReady(
  options: DesktopRuntimeRecoveryOptions,
): Promise<void> {
  for (let attempt = 1; !options.isStopping(); attempt += 1) {
    await options.wait(desktopRuntimeRecoveryDelayMs(attempt));
    if (options.isStopping()) return;
    try {
      await options.recover(attempt);
      return;
    } catch (error) {
      await options.onFailure(error, attempt);
    }
  }
}

/** Retires only the disconnected Desktop transport and asks its owner to rediscover it. */
export function signalDesktopRuntimeDisconnection(
  error: Error,
  options: DesktopRuntimeDisconnectionOptions,
): void {
  if (!options.isActive) return;
  const start = (operation: () => Promise<void> | void) => {
    try {
      void Promise.resolve(operation()).catch((failure: unknown) =>
        options.reportFailure?.(failure),
      );
    } catch (failure) {
      options.reportFailure?.(failure);
    }
  };
  start(() => options.retireResponses(error));
  start(() => options.retireConnection());
  start(() => options.notifyOwner(error));
}
