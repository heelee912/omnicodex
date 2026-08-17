import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { actionLedgerBlockers } from "../src/domain/non-interference.js";
import { HashChainedActionLedger } from "../src/infrastructure/safety/hash-chained-action-ledger.js";

const temporaryDirectories: string[] = [];

async function createLedger(): Promise<{
  directory: string;
  filePath: string;
  ledger: HashChainedActionLedger;
}> {
  const directory = await mkdtemp(join(tmpdir(), "omnicodex-ledger-"));
  temporaryDirectories.push(directory);
  const filePath = join(directory, "actions.jsonl");
  const ledger = new HashChainedActionLedger(filePath);
  await ledger.initialize();
  return { directory, filePath, ledger };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("HashChainedActionLedger", () => {
  it("starts at a stable genesis head", async () => {
    const { ledger } = await createLedger();
    expect(await ledger.readHead()).toEqual({
      integrity: "valid",
      headSequence: 0,
      headHash: "0".repeat(64),
      records: [],
    });
  });

  it("durably records intent before a terminal result", async () => {
    const { ledger } = await createLedger();
    const operation = await ledger.begin({
      kind: "child_process",
      effect: "start",
      targetClass: "codex_runtime_child",
      targetFingerprint: "runtime-a",
    });
    await operation.complete({ outcomeCode: "STARTED" });

    const view = await ledger.readAfter(0);
    expect(view.integrity).toBe("valid");
    expect(view.anchorHash).toBe("0".repeat(64));
    expect(view.records).toHaveLength(2);
    expect(view.records.map((record) => record.phase)).toEqual(["intent", "completed"]);
    expect(view.records[0]?.operationId).toBe(view.records[1]?.operationId);
    expect(actionLedgerBlockers(view.records)).toEqual([]);
  });

  it("makes an intent without a terminal record a blocker", async () => {
    const { ledger } = await createLedger();
    await ledger.begin({
      kind: "child_process",
      effect: "start",
      targetClass: "codex_runtime_child",
      targetFingerprint: "runtime-a",
    });

    const view = await ledger.readAfter(0);
    expect(actionLedgerBlockers(view.records).map((reason) => reason.code)).toContain(
      "ACTION_UNFINISHED",
    );
  });

  it("detects record tampering", async () => {
    const { filePath, ledger } = await createLedger();
    const operation = await ledger.begin({
      kind: "child_process",
      effect: "start",
      targetClass: "codex_runtime_child",
      targetFingerprint: "runtime-a",
    });
    await operation.complete();

    const original = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      original.replace("codex_runtime_child", "codex_desktop_____"),
      "utf8",
    );

    const view = await ledger.readHead();
    expect(view.integrity).toBe("invalid");
    expect(view.integrityError).toMatch(/hash mismatch/);
  });

  it("detects an unterminated crash fragment", async () => {
    const { filePath, ledger } = await createLedger();
    await writeFile(filePath, '{"sequence":1}', "utf8");
    const view = await ledger.readHead();
    expect(view.integrity).toBe("invalid");
    expect(view.integrityError).toBe("ledger has an unterminated final record");
  });

  it("binds readAfter to the exact baseline prefix hash", async () => {
    const { ledger } = await createLedger();
    const first = await ledger.begin({
      kind: "network_request",
      effect: "send",
      targetClass: "loopback_provider",
      targetFingerprint: "provider-a",
    });
    await first.complete();
    const baselineHead = await ledger.readHead();

    const second = await ledger.begin({
      kind: "protected_path_access",
      effect: "read",
      targetClass: "codex_config",
      targetFingerprint: "config-a",
    });
    await second.complete();

    const view = await ledger.readAfter(baselineHead.headSequence);
    expect(view.anchorSequence).toBe(baselineHead.headSequence);
    expect(view.anchorHash).toBe(baselineHead.headHash);
    expect(view.records).toHaveLength(2);
  });
});
