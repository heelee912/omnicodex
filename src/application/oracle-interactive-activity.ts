export type OracleInteractiveActivityDecision = "active" | "idle" | "probe" | "skip";

/**
 * Codex Desktop owns the live task lifecycle for locally visible ChatGPT
 * conversations. Oracle observation is required only when that exact local
 * status is unavailable and an active Goal still needs the remote turn read.
 */
export function decideOracleInteractiveActivity(
  nativeTaskStatus: "active" | "idle" | undefined,
  observedTurnActivity: "active" | "idle" | undefined,
  activeGoal: boolean,
): OracleInteractiveActivityDecision {
  if (nativeTaskStatus !== undefined) return nativeTaskStatus;
  if (observedTurnActivity !== undefined) return observedTurnActivity;
  return activeGoal ? "probe" : "skip";
}
