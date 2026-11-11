import type { ChatGptSettingsSurface } from "../infrastructure/chatgpt/chatgpt-app-settings-reconciler.js";

export interface OwnedOracleSettingsSurface {
  readonly targetId: string;
  readonly surface: ChatGptSettingsSurface;
  closeSession(): void;
}

export interface OracleSettingsTargetLifecycle {
  open(budget: OracleSettingsPhaseBudget): Promise<OwnedOracleSettingsSurface>;
  closeTarget(targetId: string): Promise<void>;
}

export interface OracleSettingsPhaseBudget {
  readonly signal?: AbortSignal;
  remainingMs(): number | undefined;
}

export interface OracleSettingsTargetPhases<ReconcileResult, RefreshResult> {
  readonly execute: boolean;
  /** One caller deadline shared by target open, reconcile, and refresh. */
  readonly timeoutMs?: number;
  readonly lifecycle: OracleSettingsTargetLifecycle;
  reconcile(
    surface: ChatGptSettingsSurface,
    budget: OracleSettingsPhaseBudget,
  ): Promise<ReconcileResult>;
  /** Reuse the exact owned target when reconciliation did not leave it in an OAuth transition. */
  reuseTargetForRefresh?(reconcile: ReconcileResult): boolean;
  refresh(
    surface: ChatGptSettingsSurface,
    budget: OracleSettingsPhaseBudget,
  ): Promise<RefreshResult>;
}

export interface OracleSettingsTargetPhaseResult<ReconcileResult, RefreshResult> {
  readonly reconcile: ReconcileResult;
  readonly refresh?: RefreshResult;
}

/**
 * Runs permission reconciliation and action refresh on distinct settings
 * targets. The refresh target is acquired before the reconcile target is
 * released, so a browser with no unrelated page never loses its last target
 * during the handoff.
 */
export async function runOracleSettingsTargetPhases<ReconcileResult, RefreshResult>(
  phases: OracleSettingsTargetPhases<ReconcileResult, RefreshResult>,
): Promise<OracleSettingsTargetPhaseResult<ReconcileResult, RefreshResult>> {
  const budget = createPhaseBudget(phases.timeoutMs);
  const owned: OwnedOracleSettingsSurface[] = [];
  let phase = "open_reconcile_target";
  let operationError: unknown;
  let phaseResult: OracleSettingsTargetPhaseResult<ReconcileResult, RefreshResult> | undefined;
  try {
    const reconcileTarget = await phases.lifecycle.open(budget);
    owned.push(reconcileTarget);
    phase = "reconcile_permissions";
    const reconcile = await phases.reconcile(reconcileTarget.surface, budget);
    if (!phases.execute) {
      phaseResult = { reconcile };
    } else if (phases.reuseTargetForRefresh?.(reconcile) === true) {
      phase = "refresh_actions";
      const refresh = await phases.refresh(reconcileTarget.surface, budget);
      phaseResult = { reconcile, refresh };
    } else {
      phase = "open_refresh_target";
      const refreshTarget = await phases.lifecycle.open(budget);
      owned.push(refreshTarget);
      if (refreshTarget.targetId === reconcileTarget.targetId) {
        throw new Error("CHATGPT_FRESH_SETTINGS_TARGET_NOT_ACQUIRED");
      }

      // The fresh target is connected before releasing the stale post-consent
      // session. This avoids a zero-target browser transition.
      phase = "release_reconcile_target";
      await releaseOwned(phases.lifecycle, reconcileTarget);
      owned.splice(owned.indexOf(reconcileTarget), 1);
      phase = "refresh_actions";
      const refresh = await phases.refresh(refreshTarget.surface, budget);
      phaseResult = { reconcile, refresh };
    }
  } catch (error) {
    operationError = new Error(`${toError(error).message} [oracle_settings_phase=${phase}]`, {
      cause: error,
    });
  }

  const cleanupErrors: Error[] = [];
  for (const target of [...owned].reverse()) {
    try {
      await releaseOwned(phases.lifecycle, target);
    } catch (error) {
      cleanupErrors.push(toError(error));
    }
  }
  budget.dispose();
  if (operationError !== undefined) {
    if (cleanupErrors.length === 0) throw operationError;
    throw new Error(toError(operationError).message, {
      cause: new AggregateError([toError(operationError), ...cleanupErrors]),
    });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Oracle settings targets did not close cleanly");
  }
  if (phaseResult === undefined) throw new Error("Oracle settings phases produced no result");
  return phaseResult;
}

interface DisposableOracleSettingsPhaseBudget extends OracleSettingsPhaseBudget {
  dispose(): void;
}

function createPhaseBudget(timeoutMs: number | undefined): DisposableOracleSettingsPhaseBudget {
  if (timeoutMs === undefined) {
    return { remainingMs: () => undefined, dispose: () => undefined };
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Oracle settings timeout must be a positive safe integer");
  }
  const deadlineUnixMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const remaining = deadlineUnixMs - Date.now();
    if (remaining <= 0) {
      controller.abort(new Error("ORACLE_SETTINGS_DEADLINE_EXCEEDED"));
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
    timer.unref?.();
  };
  arm();
  return {
    signal: controller.signal,
    remainingMs: () => {
      const remaining = deadlineUnixMs - Date.now();
      if (remaining <= 0 || controller.signal.aborted) {
        throw new Error("ORACLE_SETTINGS_DEADLINE_EXCEEDED", { cause: controller.signal.reason });
      }
      return Math.max(1, Math.ceil(remaining));
    },
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

async function releaseOwned(
  lifecycle: OracleSettingsTargetLifecycle,
  target: OwnedOracleSettingsSurface,
): Promise<void> {
  target.closeSession();
  await lifecycle.closeTarget(target.targetId);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
