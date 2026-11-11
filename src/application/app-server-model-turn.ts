import type { AppServerRpcClient } from "./native-tool-catalog.js";

export interface CompletedModelTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly started: unknown;
  readonly completed: unknown;
  readonly tokenUsage: unknown;
  readonly modelUsage: number;
}

/**
 * Starts exactly one model turn and waits for its exact completion and usage
 * notifications. A start acknowledgement alone is never treated as model use.
 */
export async function startModelTurnAndWait(
  client: AppServerRpcClient,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<CompletedModelTurn> {
  const threadId = requiredString(params.threadId, "threadId");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("Model turn timeout must be a positive safe integer when supplied");
  }
  if (client.subscribeNotifications === undefined) {
    throw new Error("App Server notification subscription is required for model usage evidence");
  }

  let turnId: string | undefined;
  let completed: unknown;
  let tokenUsage: unknown;
  let modelUsage: number | undefined;
  const pendingCompletions = new Map<string, unknown>();
  const pendingUsages = new Map<
    string,
    { readonly tokenUsage: unknown; readonly modelUsage: number }
  >();
  let settled = false;
  let resolveTerminal: ((value: CompletedModelTurn) => void) | undefined;
  let rejectTerminal: ((error: Error) => void) | undefined;
  let started: unknown;
  const terminal = new Promise<CompletedModelTurn>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  let cancelDeadline: (() => void) | undefined;

  const maybeResolve = (): void => {
    if (settled || turnId === undefined || completed === undefined || modelUsage === undefined) {
      return;
    }
    settled = true;
    cancelDeadline?.();
    resolveTerminal?.({ threadId, turnId, started, completed, tokenUsage, modelUsage });
  };
  const unsubscribe = client.subscribeNotifications((message) => {
    const paramsValue = objectValue(message.params);
    if (paramsValue.threadId !== threadId) return;
    if (message.method === "thread/tokenUsage/updated") {
      const notificationTurnId = stringValue(paramsValue.turnId);
      if (notificationTurnId === undefined) return;
      const usage = objectValue(paramsValue.tokenUsage);
      const last = objectValue(usage.last);
      const totalTokens = numberValue(last.totalTokens);
      if (totalTokens !== undefined && totalTokens > 0) {
        if (turnId === notificationTurnId) {
          tokenUsage = paramsValue.tokenUsage;
          modelUsage = totalTokens;
          maybeResolve();
        } else if (turnId === undefined) {
          pendingUsages.set(notificationTurnId, {
            tokenUsage: paramsValue.tokenUsage,
            modelUsage: totalTokens,
          });
        }
      }
      return;
    }
    if (message.method !== "turn/completed") return;
    const turn = objectValue(paramsValue.turn);
    const notificationTurnId = stringValue(turn.id);
    if (notificationTurnId === undefined) return;
    if (turnId === undefined) {
      pendingCompletions.set(notificationTurnId, paramsValue.turn);
      return;
    }
    if (notificationTurnId !== turnId) return;
    const status = stringValue(turn.status);
    if (status !== "completed") {
      if (!settled) {
        settled = true;
        cancelDeadline?.();
        rejectTerminal?.(new Error(`Model turn ended with status ${status ?? "unknown"}`));
      }
      return;
    }
    completed = paramsValue.turn;
    maybeResolve();
  });

  try {
    started = await client.request<unknown>("turn/start", params, timeoutMs);
    turnId = nestedString(started, "turn", "id") ?? nestedString(started, "turn", "turnId");
    if (turnId === undefined) throw new Error("App Server did not return a model turn id");
    const pendingUsage = pendingUsages.get(turnId);
    if (pendingUsage !== undefined) {
      tokenUsage = pendingUsage.tokenUsage;
      modelUsage = pendingUsage.modelUsage;
    }
    const pendingCompletion = pendingCompletions.get(turnId);
    if (pendingCompletion !== undefined) {
      const status = stringValue(objectValue(pendingCompletion).status);
      if (status !== "completed") {
        throw new Error(`Model turn ended with status ${status ?? "unknown"}`);
      }
      completed = pendingCompletion;
    }
    if (timeoutMs !== undefined) {
      cancelDeadline = scheduleDeadline(Date.now() + timeoutMs, () => {
        if (settled) return;
        settled = true;
        rejectTerminal?.(new Error("Model turn completion or usage evidence timed out"));
      });
    }
    maybeResolve();
    return await terminal;
  } finally {
    cancelDeadline?.();
    unsubscribe();
  }
}

function scheduleDeadline(deadlineUnixMs: number, expire: () => void): () => void {
  const maximumTimerDelayMs = 2_147_483_647;
  let timer: NodeJS.Timeout | undefined;
  let cancelled = false;
  const arm = (): void => {
    if (cancelled) return;
    const remainingMs = deadlineUnixMs - Date.now();
    if (remainingMs <= 0) {
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, maximumTimerDelayMs));
  };
  arm();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function nestedString(value: unknown, objectKey: string, fieldKey: string): string | undefined {
  const outer = objectValue(value);
  return stringValue(objectValue(outer[objectKey])[fieldKey]);
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
