import { randomUUID } from "node:crypto";
import type {
  ActionLedgerView,
  CodexSystemObservation,
  GuardAssessment,
  GuardBaseline,
} from "../domain/non-interference.js";
import { actionLedgerBlockers, assessNonInterference } from "../domain/non-interference.js";

export interface CodexSystemObserver {
  capture(): Promise<CodexSystemObservation>;
}

export interface ActionLedgerReader {
  readAfter(sequence: number): Promise<ActionLedgerView>;
  readHead(): Promise<ActionLedgerView>;
}

export interface BaselineRenewalProof {
  readonly invalidatedBaselineId: string;
  readonly assessment: GuardAssessment;
}

export class NonInterferenceGuard {
  readonly #observer: CodexSystemObserver;
  readonly #ledger: ActionLedgerReader;
  #baseline: GuardBaseline | undefined;

  constructor(observer: CodexSystemObserver, ledger: ActionLedgerReader) {
    this.#observer = observer;
    this.#ledger = ledger;
  }

  get baseline(): GuardBaseline | undefined {
    return this.#baseline;
  }

  async establishBaseline(): Promise<GuardBaseline> {
    const observation = await this.#observer.capture();
    const ledger = await this.#ledger.readHead();
    if (ledger.integrity !== "valid") {
      throw new Error(
        `Cannot establish baseline from invalid action ledger: ${ledger.integrityError}`,
      );
    }
    const ledgerBlockers = actionLedgerBlockers(ledger.records);
    if (ledgerBlockers.length > 0) {
      throw new Error(
        `Cannot establish baseline from unsafe action ledger: ${ledgerBlockers
          .map((reason) => reason.code)
          .join(", ")}`,
      );
    }

    const unverifiable = observation.protectedFiles.filter(
      (file) => file.status === "unverifiable",
    );
    if (unverifiable.length > 0) {
      throw new Error(
        `Cannot establish baseline: protected files are unverifiable (${unverifiable
          .map((file) => file.logicalName)
          .join(", ")})`,
      );
    }

    const baseline: GuardBaseline = {
      id: randomUUID(),
      observation,
      ledgerHeadSequence: ledger.headSequence,
      ledgerHeadHash: ledger.headHash,
    };
    this.#baseline = baseline;
    return baseline;
  }

  async verify(): Promise<GuardAssessment> {
    const baseline = this.#requireBaseline();
    const current = await this.#observer.capture();
    const ledger = await this.#ledger.readAfter(baseline.ledgerHeadSequence);
    return assessNonInterference(baseline, current, ledger);
  }

  async renewBaseline(proof: BaselineRenewalProof): Promise<GuardBaseline> {
    const baseline = this.#requireBaseline();
    if (proof.invalidatedBaselineId !== baseline.id) {
      throw new Error("Baseline renewal proof does not match the active baseline");
    }
    if (proof.assessment.state !== "BASELINE_INVALIDATED" || !proof.assessment.canRenewBaseline) {
      throw new Error("Baseline cannot be renewed from the supplied assessment");
    }
    return this.establishBaseline();
  }

  clear(): void {
    this.#baseline = undefined;
  }

  #requireBaseline(): GuardBaseline {
    if (this.#baseline === undefined) {
      throw new Error("Non-interference baseline has not been established");
    }
    return this.#baseline;
  }
}
