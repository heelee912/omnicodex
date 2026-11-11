import { randomUUID } from "node:crypto";
import type {
  CodexThreadFollowUpOptions,
  CodexThreadFollowUpResult,
  CodexThreadMessageClient,
} from "./codex-thread-message-client.js";
import {
  CodexThreadPreDispatchError,
  isUnknownThreadDispatch,
  normalizeCodexThreadSettingsOverride,
} from "./codex-thread-message-client.js";

interface ReplayEntry {
  readonly fingerprint: string;
  readonly completion: Promise<CodexThreadFollowUpResult>;
  expiresAt: number | undefined;
}

export interface CodexThreadMessageRouterOptions {
  readonly replayWindowMs?: number;
}

/**
 * Prefers the already-running desktop owner and falls back only when no desktop
 * window owns the destination thread. A detached failure that occurs before a
 * turn submission gets one final desktop-owner check to close the ownership
 * race without replaying an acknowledged or unknown-outcome model turn.
 */
export class CodexThreadMessageRouter implements CodexThreadMessageClient {
  readonly #desktop: CodexThreadMessageClient;
  readonly #detached: CodexThreadMessageClient;
  readonly #replayWindowMs: number | undefined;
  readonly #replays = new Map<string, ReplayEntry>();

  constructor(
    desktop: CodexThreadMessageClient,
    detached: CodexThreadMessageClient,
    options: CodexThreadMessageRouterOptions = {},
  ) {
    this.#desktop = desktop;
    this.#detached = detached;
    this.#replayWindowMs = replayWindow(options.replayWindowMs);
  }

  async sendFollowUpMessage(
    threadId: string,
    prompt: string,
    options: CodexThreadFollowUpOptions = {},
  ): Promise<CodexThreadFollowUpResult> {
    const dispatchOptions: CodexThreadFollowUpOptions = {
      ...options,
      clientUserMessageId: options.clientUserMessageId ?? randomUUID(),
    };
    const key = dispatchOptions.clientUserMessageId as string;
    const fingerprint = followUpFingerprint(threadId, prompt, dispatchOptions);
    const now = Date.now();
    for (const [candidate, replay] of this.#replays) {
      if (replay.expiresAt !== undefined && replay.expiresAt <= now) {
        this.#replays.delete(candidate);
      }
    }
    const replay = this.#replays.get(key);
    if (replay !== undefined) {
      assertMatchingReplay(key, replay.fingerprint, fingerprint);
      return replay.completion;
    }

    let completion!: Promise<CodexThreadFollowUpResult>;
    completion = this.#dispatch(threadId, prompt, dispatchOptions).then(
      (result) => {
        const current = this.#replays.get(key);
        if (current?.completion === completion) {
          current.expiresAt = replayExpiry(this.#replayWindowMs);
        }
        return result;
      },
      (error: unknown) => {
        const current = this.#replays.get(key);
        if (current?.completion === completion) {
          if (isUnknownThreadDispatch(error)) {
            current.expiresAt = replayExpiry(this.#replayWindowMs);
          } else {
            this.#replays.delete(key);
          }
        }
        throw error;
      },
    );
    this.#replays.set(key, {
      fingerprint,
      completion,
      expiresAt: undefined,
    });
    return completion;
  }

  async #dispatch(
    threadId: string,
    prompt: string,
    options: CodexThreadFollowUpOptions,
  ): Promise<CodexThreadFollowUpResult> {
    try {
      const result = await this.#desktop.sendFollowUpMessage(threadId, prompt, options);
      return { ...result, transport: result.transport ?? "desktop_ipc" };
    } catch (error) {
      if (!isNoDesktopOwner(error, threadId)) throw error;
    }

    try {
      return await this.#detached.sendFollowUpMessage(threadId, prompt, options);
    } catch (detachedError) {
      if (!(detachedError instanceof CodexThreadPreDispatchError)) throw detachedError;
      try {
        const result = await this.#desktop.sendFollowUpMessage(threadId, prompt, options);
        return { ...result, transport: result.transport ?? "desktop_ipc" };
      } catch (desktopError) {
        if (!isNoDesktopOwner(desktopError, threadId)) throw desktopError;
        throw detachedError;
      }
    }
  }
}

function followUpFingerprint(
  threadId: string,
  prompt: string,
  options: CodexThreadFollowUpOptions,
): string {
  const threadSettings = normalizeCodexThreadSettingsOverride(options.threadSettings);
  return JSON.stringify({
    threadId,
    prompt,
    cwd: options.cwd,
    hostId: options.hostId,
    threadSettings,
  });
}

function assertMatchingReplay(key: string, expected: string, actual: string): void {
  if (expected === actual) return;
  throw new Error(`Codex thread clientUserMessageId ${key} was reused with different input`);
}

function replayWindow(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("replayWindowMs must be a positive safe integer");
  }
  return value;
}

function replayExpiry(replayWindowMs: number | undefined): number | undefined {
  return replayWindowMs === undefined ? undefined : Date.now() + replayWindowMs;
}

function isNoDesktopOwner(error: unknown, threadId: string): boolean {
  return (
    error instanceof Error &&
    error.message === `No running Codex desktop window owns thread ${threadId}`
  );
}
