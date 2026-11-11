export interface ChromeFileApprovalResultSummary {
  readonly outcome: string;
  readonly candidateCount?: number;
  readonly activatedCount?: number;
  readonly error?: string;
  readonly rateLimit?: Readonly<Record<string, unknown>>;
}

/** Keep the receipt until an active response settles and the tab can be checked again. */
export function chromeApprovalReceiptSynchronized(outcome: string): boolean {
  return [
    "refreshed",
    "approval_not_visible",
    "conversation_not_open",
    "conversation_changed",
  ].includes(outcome);
}

/** Recover one semantic result from every native App Server/Node REPL envelope. */
export function chromeFileApprovalResultSummary(value: unknown): ChromeFileApprovalResultSummary {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "string") {
      enqueueJsonValues(queue, current);
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!isObject(current) || seen.has(current)) continue;
    seen.add(current);
    if (current.isError === true || current.success === false || current.ok === false) {
      const error = nativeFailureMessage(current);
      return {
        outcome: "native_call_failed",
        ...(error === undefined ? {} : { error }),
      };
    }
    if (typeof current.outcome === "string") {
      return {
        outcome: current.outcome,
        ...(isObject(current.rateLimit) ? { rateLimit: current.rateLimit } : {}),
        ...(typeof current.error === "string" ? { error: current.error } : {}),
        ...(typeof current.candidateCount === "number"
          ? { candidateCount: current.candidateCount }
          : {}),
        ...(typeof current.activatedCount === "number"
          ? { activatedCount: current.activatedCount }
          : {}),
      };
    }
    queue.push(...Object.values(current));
  }
  return { outcome: "native_result_unclassified" };
}

function nativeFailureMessage(value: Record<string, unknown>): string | undefined {
  const messages: string[] = [];
  const queue: unknown[] = [value.error, value.message, value.content];
  const seen = new Set<object>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (typeof current === "string") {
      const normalized = current.replace(/\s+/gu, " ").trim();
      if (normalized.length > 0) messages.push(normalized);
      continue;
    }
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    if (!isObject(current) || seen.has(current)) continue;
    seen.add(current);
    queue.push(current.error, current.message, current.text);
  }
  if (messages.length === 0) return undefined;
  return [...new Set(messages)].join(" | ").slice(0, 2_048);
}

function enqueueJsonValues(queue: unknown[], text: string): void {
  const normalized = text.trim();
  if (normalized.length === 0) return;
  try {
    queue.push(JSON.parse(normalized));
    return;
  } catch {
    // Some App Server versions prefix Node REPL output with a diagnostic line.
  }
  for (const line of normalized.split(/\r?\n/gu)) {
    const candidate = line.trim();
    if (candidate.length === 0 || candidate === normalized) continue;
    try {
      queue.push(JSON.parse(candidate));
    } catch {
      // Human-readable diagnostics are not approval results.
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
