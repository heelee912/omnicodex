export interface CodexThreadSettingsOverride {
  readonly model?: string;
  readonly effort?: string | null;
}

/**
 * Canonicalizes optional thread overrides before they cross a native boundary.
 * A missing or blank model/effort means "inherit the thread's configured
 * setting" and must therefore be omitted, not serialized as an unsupported
 * override. Explicit null effort remains meaningful and is preserved.
 */
export function normalizeCodexThreadSettingsOverride(
  settings: CodexThreadSettingsOverride | undefined,
): CodexThreadSettingsOverride | undefined {
  if (settings === undefined) return undefined;
  const model = typeof settings.model === "string" ? settings.model.trim() : undefined;
  const effort = typeof settings.effort === "string" ? settings.effort.trim() : settings.effort;
  const normalized: CodexThreadSettingsOverride = {
    ...(model === undefined || model.length === 0 ? {} : { model }),
    ...(effort === undefined || effort === "" ? {} : { effort }),
  };
  return normalized.model === undefined && normalized.effort === undefined ? undefined : normalized;
}

export interface CodexThreadFollowUpOptions {
  readonly cwd?: string;
  readonly hostId?: string;
  readonly threadSettings?: CodexThreadSettingsOverride;
  /** Stable native user-message identity used to make retries non-duplicating. */
  readonly clientUserMessageId?: string;
  /** Exact caller completion timeout. Omit to wait indefinitely. */
  readonly timeoutMs?: number;
  /** Exact caller absolute completion deadline. */
  readonly deadlineUnixMs?: number;
  /** Exact caller cancellation boundary. */
  readonly signal?: AbortSignal;
}

export interface CodexThreadFollowUpResult {
  readonly threadId: string;
  readonly ownerClientId: string;
  readonly disposition: "started" | "queued";
  readonly clientUserMessageId?: string;
  readonly nativeResult: unknown;
  readonly transport?: "desktop_ipc" | "detached_app_server";
  readonly queue?: {
    readonly clientUserMessageId: string;
    readonly acceptedAt: number;
    readonly position: number;
    readonly persisted: true;
    readonly dispatchAfter: "active_turn_terminal";
  };
}

/**
 * One semantic boundary for continuing an existing Codex thread. Implementations
 * may acknowledge either a native turn start or a durable queued follow-up.
 * A queued acknowledgement is not execution: it must include authoritative
 * queue readback and the implementation must remove it only after native turn
 * start acknowledgement.
 */
export interface CodexThreadMessageClient {
  sendFollowUpMessage(
    threadId: string,
    prompt: string,
    options?: CodexThreadFollowUpOptions,
  ): Promise<CodexThreadFollowUpResult>;
}

/**
 * Marks a dispatch failure for which no native model turn was submitted. The
 * router may perform one final desktop-owner lookup only for this error class.
 */
export class CodexThreadPreDispatchError extends Error {
  readonly retryDesktopOwnerLookup = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexThreadPreDispatchError";
  }
}

/**
 * The native dispatch may have succeeded, but its acknowledgement was lost.
 * Callers must not replay this prompt through another transport.
 */
export class CodexThreadUnknownDispatchError extends Error {
  readonly unknownDispatchOutcome = true;
  readonly clientUserMessageId: string;

  constructor(message: string, clientUserMessageId: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexThreadUnknownDispatchError";
    this.clientUserMessageId = clientUserMessageId;
  }
}

export function isUnknownThreadDispatch(error: unknown): error is CodexThreadUnknownDispatchError {
  return error instanceof CodexThreadUnknownDispatchError;
}
