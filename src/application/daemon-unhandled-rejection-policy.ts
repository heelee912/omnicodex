/**
 * Request cancellation is a normal, request-scoped outcome. Node may surface
 * an AbortError through the process-level rejection hook when a disconnected
 * HTTP client races an async transport cleanup. That must never terminate the
 * shared OmniCodex daemon or unrelated native sessions.
 *
 * Deliberately do not match error messages: an arbitrary fault that happens to
 * say "aborted" is still fatal. Only the platform cancellation identity (or a
 * causal chain containing it) is accepted.
 */
export function isExpectedCancellationRejection(reason: unknown): boolean {
  const visited = new Set<object>();
  let current = reason;

  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || visited.has(current)) return false;
    visited.add(current);

    const record = current as {
      readonly name?: unknown;
      readonly code?: unknown;
      readonly cause?: unknown;
    };
    if (record.name === "AbortError" || record.code === "ABORT_ERR") return true;
    current = record.cause;
  }

  return false;
}
