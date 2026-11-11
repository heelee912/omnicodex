import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeCandidate } from "../domain/runtime.js";

export interface EngineRefreshOutcome {
  readonly status: "current" | "deferred" | "busy" | "installed" | "staged";
  readonly activeExecutablePath?: string;
  readonly restartRequired?: boolean;
}

export interface EngineBuildFollowerOptions {
  readonly readDesktopExecutablePath: () => Promise<string | undefined>;
  readonly discover: (
    desktopExecutablePath: string,
  ) => Promise<{ readonly candidates: readonly RuntimeCandidate[] }>;
  readonly activeCandidate: () => RuntimeCandidate | undefined;
  readonly switchRuntime: (canonicalPath: string) => Promise<unknown>;
  readonly refreshEngine?: () => Promise<EngineRefreshOutcome | undefined>;
  readonly onRefreshOutcome?: (outcome: EngineRefreshOutcome) => void;
  readonly refreshIntervalMs?: number;
  readonly nowUnixMs?: () => number;
  readonly onError?: (error: Error) => void;
  readonly intervalMs?: number;
}

/** Follows the desktop's active engine build with the existing safe runtime switch. */
export class EngineBuildFollower {
  readonly #options: EngineBuildFollowerOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #started = false;
  #stopped = false;
  #lastRefreshUnixMs: number | undefined;
  #desiredExecutablePath: string | undefined;
  #reportedStagedPath: string | undefined;
  #unmatchedDesktopPath: string | undefined;

  constructor(options: EngineBuildFollowerOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#stopped = false;
    this.#lastRefreshUnixMs = undefined;
    this.#desiredExecutablePath = undefined;
    this.#reportedStagedPath = undefined;
    this.#schedule(10_000);
  }

  stop(): void {
    this.#started = false;
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#desiredExecutablePath = undefined;
    this.#reportedStagedPath = undefined;
  }

  async followOnce(): Promise<boolean> {
    if (this.#running) return false;
    this.#running = true;
    try {
      const nowUnixMs = this.#options.nowUnixMs ?? Date.now;
      if (
        this.#options.refreshEngine !== undefined &&
        (this.#lastRefreshUnixMs === undefined ||
          nowUnixMs() - this.#lastRefreshUnixMs >= (this.#options.refreshIntervalMs ?? 300_000))
      ) {
        try {
          const outcome = await this.#options.refreshEngine();
          if (outcome?.status === "current" || outcome?.status === "installed") {
            this.#desiredExecutablePath = outcome.activeExecutablePath;
          }
          if (outcome !== undefined && outcome.status === "installed") {
            this.#options.onRefreshOutcome?.(outcome);
          }
        } finally {
          this.#lastRefreshUnixMs = nowUnixMs();
        }
      }
      if (this.#stopped) return false;
      const active = this.#options.activeCandidate();
      if (active === undefined) return false;
      const desktopPath = await this.#options.readDesktopExecutablePath();
      if (desktopPath === undefined || this.#stopped) {
        this.#unmatchedDesktopPath = undefined;
        return false;
      }
      const desiredPath = this.#desiredExecutablePath;
      if (
        desiredPath !== undefined &&
        resolve(desiredPath).toLowerCase() !== resolve(desktopPath).toLowerCase()
      ) {
        if (this.#reportedStagedPath !== desiredPath) {
          this.#reportedStagedPath = desiredPath;
          this.#options.onRefreshOutcome?.({
            status: "staged",
            activeExecutablePath: desiredPath,
            restartRequired: true,
          });
        }
      } else {
        this.#reportedStagedPath = undefined;
      }
      const report = await this.#options.discover(desktopPath);
      if (this.#stopped) return false;
      const canonicalDesktopPath = await realpath(desktopPath).catch(() => resolve(desktopPath));
      const desktopCandidate = report.candidates.find(
        (candidate) =>
          candidate.source === "managed_install" &&
          resolve(candidate.canonicalPath).toLowerCase() === canonicalDesktopPath.toLowerCase(),
      );
      if (desktopCandidate === undefined) {
        if (this.#unmatchedDesktopPath !== canonicalDesktopPath.toLowerCase()) {
          this.#unmatchedDesktopPath = canonicalDesktopPath.toLowerCase();
          try {
            this.#options.onError?.(
              new Error(
                `Desktop engine is absent from verified runtime candidates: ${desktopPath}`,
              ),
            );
          } catch {
            // Diagnostic observers cannot change runtime selection.
          }
        }
        return false;
      }
      this.#unmatchedDesktopPath = undefined;
      if (
        resolve(desktopCandidate.canonicalPath).toLowerCase() ===
        resolve(active.canonicalPath).toLowerCase()
      ) {
        return false;
      }
      if (this.#options.activeCandidate()?.canonicalPath !== active.canonicalPath) return false;
      await this.#options.switchRuntime(desktopCandidate.canonicalPath);
      return true;
    } finally {
      this.#running = false;
    }
  }

  #schedule(delayMs: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.followOnce()
        .catch((error: unknown) => {
          try {
            this.#options.onError?.(toError(error));
          } catch {
            // Diagnostic failures cannot interrupt future build checks.
          }
        })
        .finally(() => {
          if (!this.#stopped) this.#schedule(this.#options.intervalMs ?? 60_000);
        });
    }, delayMs);
    this.#timer.unref?.();
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
