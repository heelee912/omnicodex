export interface BoundedShutdownPhase {
  readonly name: string;
  /** Caller-selected deadline for this phase. Omit to wait for full settlement. */
  readonly budgetMs?: number;
  /**
   * Starts this phase only after every earlier phase has either settled or
   * exhausted its own budget. Independent tasks in one phase run together.
   */
  readonly run: () => readonly Promise<unknown>[];
}

export interface BoundedShutdownPhaseResult {
  readonly name: string;
  readonly timedOut: boolean;
  readonly errors: readonly Error[];
}

export interface BoundedShutdownObserver {
  readonly onPhaseStart?: (name: string) => Promise<void> | void;
  readonly onPhaseComplete?: (result: BoundedShutdownPhaseResult) => Promise<void> | void;
}

/**
 * Runs ordered shutdown phases without letting a wedged task suppress later
 * cleanup. A timed-out task is deliberately not cancelled: its owning
 * component remains responsible for exact-target termination while the next
 * independent phase is allowed to proceed.
 */
export async function runBoundedShutdownSequence(
  phases: readonly BoundedShutdownPhase[],
  observer: BoundedShutdownObserver = {},
): Promise<readonly BoundedShutdownPhaseResult[]> {
  const results: BoundedShutdownPhaseResult[] = [];
  for (const phase of phases) {
    assertPhaseBudget(phase);
    observeWithoutBlocking(() => observer.onPhaseStart?.(phase.name));
    let tasks: readonly Promise<unknown>[];
    try {
      tasks = phase.run();
    } catch (error) {
      const result = {
        name: phase.name,
        timedOut: false,
        errors: [toError(error)],
      } satisfies BoundedShutdownPhaseResult;
      results.push(result);
      observeWithoutBlocking(() => observer.onPhaseComplete?.(result));
      continue;
    }

    const settled = Promise.allSettled(tasks);
    const outcome =
      phase.budgetMs === undefined
        ? { settled: true as const, value: await settled }
        : await settleBefore(settled, phase.budgetMs);
    const result = {
      name: phase.name,
      timedOut: !outcome.settled,
      errors: outcome.settled
        ? outcome.value.flatMap((task) =>
            task.status === "rejected" ? [toError(task.reason)] : [],
          )
        : [],
    } satisfies BoundedShutdownPhaseResult;
    results.push(result);
    observeWithoutBlocking(() => observer.onPhaseComplete?.(result));
  }
  return results;
}

export function shutdownSequenceErrors(
  results: readonly BoundedShutdownPhaseResult[],
): readonly Error[] {
  return results.flatMap((result) => [
    ...(result.timedOut ? [new Error(`Shutdown phase ${result.name} exceeded its deadline`)] : []),
    ...result.errors.map(
      (error) =>
        new Error(`Shutdown phase ${result.name} failed: ${error.message}`, { cause: error }),
    ),
  ]);
}

function settleBefore(
  operation: Promise<readonly PromiseSettledResult<unknown>[]>,
  timeoutMs: number,
): Promise<
  | { readonly settled: true; readonly value: readonly PromiseSettledResult<unknown>[] }
  | { readonly settled: false }
> {
  return new Promise((resolveOutcome) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolveOutcome({ settled: false });
    }, timeoutMs);
    timer.unref?.();
    void operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolveOutcome({ settled: true, value });
      },
      (error: unknown) => {
        // Promise.allSettled cannot reject, but preserve an unexpected
        // aggregate failure rather than silently converting it to success.
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolveOutcome({
          settled: true,
          value: [{ status: "rejected", reason: error }],
        });
      },
    );
  });
}

function assertPhaseBudget(phase: BoundedShutdownPhase): void {
  if (
    phase.budgetMs !== undefined &&
    (!Number.isSafeInteger(phase.budgetMs) || phase.budgetMs <= 0)
  ) {
    throw new Error(`Shutdown phase ${phase.name} requires a positive integer budget`);
  }
}

function observeWithoutBlocking(operation: () => Promise<void> | void | undefined): void {
  try {
    void Promise.resolve(operation()).catch(() => undefined);
  } catch {
    // Shutdown observability must never become a shutdown dependency.
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
