import { availableParallelism } from "node:os";
import type { NativeToolRegistryEntry } from "./native-tool-registry.js";

export interface NativeExecutionOrdering {
  readonly threadId?: string;
  readonly processId?: string;
  readonly filePaths?: readonly string[];
}

export interface NativeExecutionRequest {
  readonly entry: NativeToolRegistryEntry;
  readonly ordering?: NativeExecutionOrdering | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface NativeExecutionSchedulerOptions {
  readonly shellConcurrency?: number;
  readonly defaultTimeoutMs?: number;
}

/**
 * Fair, bounded scheduler for native host operations. It deliberately derives
 * lanes from the runtime catalog instead of maintaining a second tool list.
 */
export class NativeExecutionScheduler {
  readonly #shell: FairSemaphore;
  readonly #ui = new FairSemaphore(1);
  readonly #nodeRepl = new FairSemaphore(1);
  readonly #keys = new KeyedSequencer();
  readonly #defaultTimeoutMs: number | undefined;

  constructor(options: NativeExecutionSchedulerOptions = {}) {
    const detectedCpuCount = availableParallelism();
    this.#shell = new FairSemaphore(
      options.shellConcurrency ?? Math.max(1, Math.min(32, detectedCpuCount)),
    );
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
  }

  async run<T>(request: NativeExecutionRequest, operation: () => Promise<T>): Promise<T> {
    const releaseKey = await this.#keys.acquire(orderingKeys(request), request.signal);
    let releaseLane: (() => void) | undefined;
    let released = false;
    let trackedOwnsRelease = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseLane?.();
      releaseKey();
    };
    try {
      const lane = executionLane(request.entry);
      releaseLane =
        lane === "ui"
          ? await this.#ui.acquire(request.signal)
          : lane === "node_repl"
            ? await this.#nodeRepl.acquire(request.signal)
            : lane === "shell"
              ? await this.#shell.acquire(request.signal)
              : undefined;
      let running: Promise<T>;
      try {
        running = operation();
      } catch (error) {
        release();
        throw error;
      }
      // A caller timeout must not free a mutually-exclusive lane while the
      // underlying native operation is still running. Its completion owns the
      // lease; the caller-facing deadline only bounds response latency.
      const tracked = running.finally(release);
      trackedOwnsRelease = true;
      return await withDeadline(
        tracked,
        request.timeoutMs ?? this.#defaultTimeoutMs,
        request.signal,
      );
    } catch (error) {
      // If the operation itself is still pending, its `finally` owns release.
      // Otherwise this is a queue/lane acquisition or synchronous-call error.
      if (!trackedOwnsRelease) release();
      throw error;
    }
  }
}

type Lane = "parallel" | "shell" | "ui" | "node_repl";

function executionLane(entry: NativeToolRegistryEntry): Lane {
  const identity = `${entry.nativeNamespace}/${entry.originalName}/${entry.source}`.toLowerCase();
  if (/computer.?use|chrome|browser/.test(identity)) return "ui";
  if (/node.?repl/.test(identity)) return "node_repl";
  if (/shell|terminal|exec_command|shell_command/.test(identity)) return "shell";
  return "parallel";
}

function orderingKeys(request: NativeExecutionRequest): string[] {
  const ordering = request.ordering;
  if (ordering === undefined) return [];
  const keys = [
    ...(ordering.threadId === undefined ? [] : [`thread:${ordering.threadId}`]),
    ...(ordering.processId === undefined ? [] : [`process:${ordering.processId}`]),
    ...(ordering.filePaths ?? []).map((path) => `file:${normalizePath(path)}`),
  ];
  return [...new Set(keys)].sort();
}

function normalizePath(path: string): string {
  return path.replaceAll("/", "\\").toLowerCase();
}

class KeyedSequencer {
  readonly #locks = new Map<string, FairSemaphore>();

  async acquire(keys: readonly string[], signal?: AbortSignal): Promise<() => void> {
    const releases: Array<() => void> = [];
    try {
      for (const key of keys) {
        let lock = this.#locks.get(key);
        if (lock === undefined) {
          lock = new FairSemaphore(1, () => this.#locks.delete(key));
          this.#locks.set(key, lock);
        }
        releases.push(await lock.acquire(signal));
      }
      return () => {
        for (const release of releases.reverse()) release();
      };
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
  }
}

interface SemaphoreWaiter {
  readonly resolve: (release: () => void) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal | undefined;
  abort?: () => void;
}

class FairSemaphore {
  readonly #limit: number;
  readonly #onIdle: (() => void) | undefined;
  #active = 0;
  readonly #queue: SemaphoreWaiter[] = [];

  constructor(limit: number, onIdle?: () => void) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be positive");
    this.#limit = limit;
    this.#onIdle = onIdle;
  }

  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject, signal };
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(abortError());
          this.#notifyIdle();
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.#queue.push(waiter);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) break;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener("abort", waiter.abort);
      this.#active += 1;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#active -= 1;
        this.#drain();
        this.#notifyIdle();
      });
    }
  }

  #notifyIdle(): void {
    if (this.#active === 0 && this.#queue.length === 0) this.#onIdle?.();
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  if (timeoutMs === undefined && signal === undefined) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    if (timeoutMs !== undefined) {
      const bounded = Math.max(1, Math.trunc(timeoutMs));
      timer = setTimeout(
        () => reject(new Error(`Native tool timed out after ${bounded}ms`)),
        bounded,
      );
    }
    if (signal !== undefined) {
      abortListener = () => reject(abortError());
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    return await Promise.race([operation, boundary]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
  }
}

function abortError(): Error {
  const error = new Error("Native tool call cancelled");
  error.name = "AbortError";
  return error;
}
