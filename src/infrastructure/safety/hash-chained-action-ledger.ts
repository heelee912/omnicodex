import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ActionEffect,
  ActionKind,
  ActionLedgerView,
  ActionRecord,
  PersistentMutationGrant,
} from "../../domain/non-interference.js";
import { canonicalJson } from "./canonical-json.js";

const GENESIS_HASH = "0".repeat(64);

interface StoredActionRecord extends ActionRecord {
  readonly previousHash: string;
  readonly entryHash: string;
}

export interface ActionIntent {
  readonly kind: ActionKind;
  readonly effect: ActionEffect;
  readonly targetClass: string;
  readonly targetFingerprint: string;
  readonly authorization?: PersistentMutationGrant;
}

export interface ActionCompletion {
  readonly outcomeCode?: string;
}

export interface ActionOperation {
  readonly operationId: string;
  complete(completion?: ActionCompletion): Promise<void>;
  fail(completion?: ActionCompletion): Promise<void>;
}

export class HashChainedActionLedger {
  readonly #filePath: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const handle = await open(this.#filePath, "a", 0o600);
    await handle.close();
    const view = await this.readHead();
    if (view.integrity !== "valid") {
      throw new Error(`Action ledger is invalid: ${view.integrityError}`);
    }
  }

  async begin(intent: ActionIntent): Promise<ActionOperation> {
    const operationId = randomUUID();
    await this.#append({
      operationId,
      ...intent,
      phase: "intent",
    });

    let terminalWritten = false;
    const finish = async (phase: "completed" | "failed", completion?: ActionCompletion) => {
      if (terminalWritten) {
        throw new Error(`Operation ${operationId} already has a terminal record`);
      }
      terminalWritten = true;
      await this.#append({
        operationId,
        kind: intent.kind,
        effect: intent.effect,
        phase,
        targetClass: intent.targetClass,
        targetFingerprint: intent.targetFingerprint,
        ...(intent.authorization === undefined ? {} : { authorization: intent.authorization }),
        ...(completion?.outcomeCode === undefined ? {} : { outcomeCode: completion.outcomeCode }),
      });
    };

    return {
      operationId,
      complete: async (completion) => finish("completed", completion),
      fail: async (completion) => finish("failed", completion),
    };
  }

  async readHead(): Promise<ActionLedgerView> {
    return this.#read(0, false);
  }

  async readAfter(sequence: number): Promise<ActionLedgerView> {
    return this.#read(sequence, true);
  }

  async #append(input: Omit<ActionRecord, "sequence" | "timestampUnixMs">): Promise<void> {
    const run = async () => {
      const current = await this.#read(0, false);
      if (current.integrity !== "valid") {
        throw new Error(`Refusing to append to invalid action ledger: ${current.integrityError}`);
      }

      const record: ActionRecord = {
        sequence: current.headSequence + 1,
        timestampUnixMs: Date.now(),
        ...input,
      };
      const previousHash = current.headHash;
      const entryHash = hashEntry(previousHash, record);
      const stored: StoredActionRecord = {
        ...record,
        previousHash,
        entryHash,
      };

      const handle = await open(this.#filePath, "a", 0o600);
      try {
        await handle.write(`${canonicalJson(stored)}\n`, undefined, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    };

    const scheduled = this.#tail.then(run, run);
    this.#tail = scheduled.catch(() => undefined);
    await scheduled;
  }

  async #read(afterSequence: number, filterRecords: boolean): Promise<ActionLedgerView> {
    let raw: string;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      const code = getErrorCode(error);
      if (code === "ENOENT") {
        if (filterRecords && afterSequence > 0) {
          return {
            integrity: "invalid",
            headSequence: 0,
            headHash: GENESIS_HASH,
            records: [],
            integrityError: "ledger is missing after a non-genesis baseline",
          };
        }
        return {
          integrity: "valid",
          headSequence: 0,
          headHash: GENESIS_HASH,
          ...(filterRecords ? { anchorSequence: 0, anchorHash: GENESIS_HASH } : {}),
          records: [],
        };
      }
      return {
        integrity: "invalid",
        headSequence: 0,
        headHash: GENESIS_HASH,
        records: [],
        integrityError: `ledger read failed (${code ?? "unknown"})`,
      };
    }

    const lines = raw.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    } else if (raw.length > 0) {
      return {
        integrity: "invalid",
        headSequence: 0,
        headHash: GENESIS_HASH,
        records: [],
        integrityError: "ledger has an unterminated final record",
      };
    }

    const allRecords: StoredActionRecord[] = [];
    let expectedPreviousHash = GENESIS_HASH;
    let expectedSequence = 1;

    for (const [index, line] of lines.entries()) {
      let candidate: unknown;
      try {
        candidate = JSON.parse(line);
      } catch {
        return invalidLedgerView(
          allRecords,
          `ledger record ${index + 1} is not valid JSON`,
          afterSequence,
          filterRecords,
        );
      }
      if (!isStoredActionRecord(candidate)) {
        return invalidLedgerView(
          allRecords,
          `ledger record ${index + 1} has an invalid shape`,
          afterSequence,
          filterRecords,
        );
      }
      if (
        candidate.sequence !== expectedSequence ||
        candidate.previousHash !== expectedPreviousHash
      ) {
        return invalidLedgerView(
          allRecords,
          `ledger chain mismatch at sequence ${candidate.sequence}`,
          afterSequence,
          filterRecords,
        );
      }
      const { entryHash, previousHash, ...record } = candidate;
      if (entryHash !== hashEntry(previousHash, record)) {
        return invalidLedgerView(
          allRecords,
          `ledger hash mismatch at sequence ${candidate.sequence}`,
          afterSequence,
          filterRecords,
        );
      }

      allRecords.push(candidate);
      expectedSequence += 1;
      expectedPreviousHash = entryHash;
    }

    if (filterRecords && afterSequence > allRecords.length) {
      return {
        integrity: "invalid",
        headSequence: allRecords.at(-1)?.sequence ?? 0,
        headHash: allRecords.at(-1)?.entryHash ?? GENESIS_HASH,
        records: [],
        integrityError: "ledger is shorter than the requested baseline anchor",
      };
    }

    const anchorHash =
      afterSequence === 0 ? GENESIS_HASH : allRecords[afterSequence - 1]?.entryHash;
    if (filterRecords && anchorHash === undefined) {
      return {
        integrity: "invalid",
        headSequence: allRecords.at(-1)?.sequence ?? 0,
        headHash: allRecords.at(-1)?.entryHash ?? GENESIS_HASH,
        records: [],
        integrityError: "ledger baseline anchor is unavailable",
      };
    }

    return {
      integrity: "valid",
      headSequence: allRecords.at(-1)?.sequence ?? 0,
      headHash: allRecords.at(-1)?.entryHash ?? GENESIS_HASH,
      ...(filterRecords
        ? {
            anchorSequence: afterSequence,
            anchorHash: anchorHash as string,
          }
        : {}),
      records: selectedRecords(allRecords, afterSequence, filterRecords),
    };
  }
}

function selectedRecords(
  records: readonly StoredActionRecord[],
  afterSequence: number,
  filterRecords: boolean,
): readonly ActionRecord[] {
  const selected = filterRecords
    ? records.filter((record) => record.sequence > afterSequence)
    : records;
  return selected.map(
    ({ entryHash: _entryHash, previousHash: _previousHash, ...record }) => record,
  );
}

function invalidLedgerView(
  records: readonly StoredActionRecord[],
  integrityError: string,
  afterSequence: number,
  filterRecords: boolean,
): ActionLedgerView {
  return {
    integrity: "invalid",
    headSequence: records.at(-1)?.sequence ?? 0,
    headHash: records.at(-1)?.entryHash ?? GENESIS_HASH,
    records: selectedRecords(records, afterSequence, filterRecords),
    integrityError,
  };
}

function hashEntry(previousHash: string, record: ActionRecord): string {
  return createHash("sha256")
    .update(previousHash, "utf8")
    .update("\n", "utf8")
    .update(canonicalJson(record), "utf8")
    .digest("hex");
}

function isStoredActionRecord(value: unknown): value is StoredActionRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(record.sequence) &&
    typeof record.timestampUnixMs === "number" &&
    typeof record.operationId === "string" &&
    typeof record.kind === "string" &&
    typeof record.effect === "string" &&
    typeof record.phase === "string" &&
    typeof record.targetClass === "string" &&
    typeof record.targetFingerprint === "string" &&
    typeof record.previousHash === "string" &&
    typeof record.entryHash === "string"
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
