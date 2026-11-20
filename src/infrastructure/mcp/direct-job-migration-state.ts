import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { canonicalJson } from "../safety/canonical-json.js";

interface SourceIdentity {
  readonly size: number;
  readonly mtimeMs: number;
  readonly device: string;
  readonly inode: string;
  readonly sha256: string;
}

interface PendingMigration {
  readonly schemaVersion: 1;
  readonly state: "pending";
  readonly databasePathDigest: string;
  readonly migrationId: string;
  readonly source: SourceIdentity | null;
}

interface CommittedMigration {
  readonly schemaVersion: 1;
  readonly state: "committed";
  readonly pendingChecksum: string;
  readonly bootstrapChecksum: string;
}

export interface DirectJobMigrationState {
  readonly pending: PendingMigration;
  readonly pendingChecksum: string;
  readonly committed: CommittedMigration | undefined;
}

export function directJobMigrationPath(snapshotPath: string): string {
  return `${snapshotPath}.sqlite.migration`;
}

/** Permanent append-only witness: pending is flushed BEFORE SQLite is created. */
export async function prepareDirectJobMigration(
  snapshotPath: string,
): Promise<DirectJobMigrationState> {
  const existing = await readDirectJobMigration(snapshotPath);
  if (existing !== undefined) return existing;
  // An unmarked existing database has unknown history; never bless or overwrite it.
  try {
    await stat(`${snapshotPath}.sqlite`);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await stat(`${snapshotPath}.sqlite${suffix}`);
      } catch (error) {
        if (hasCode(error, "ENOENT")) continue;
        throw error;
      }
      throw new Error("Direct job SQLite sidecars exist without external migration state");
    }
    const pending: PendingMigration = {
      schemaVersion: 1,
      state: "pending",
      databasePathDigest: pathDigest(snapshotPath),
      migrationId: randomUUID(),
      source: await sourceIdentity(snapshotPath),
    };
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(directJobMigrationPath(snapshotPath), "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const winner = await readDirectJobMigration(snapshotPath);
      if (winner === undefined) invalid();
      return winner;
    }
    try {
      await handle.writeFile(`${envelope(pending)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncParent(snapshotPath);
    return { pending, pendingChecksum: digest(pending), committed: undefined };
  }
  throw new Error("Direct job SQLite exists without its external migration state");
}

/** Bounded, strict parsing; partial/torn writes fail closed, not 'missing'. */
export async function readDirectJobMigration(
  snapshotPath: string,
): Promise<DirectJobMigrationState | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(directJobMigrationPath(snapshotPath), "r+");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (size < 1 || size > 8_192) invalid();
    const bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== size) invalid();
    const raw = bytes.subarray(0, size).toString("utf8");
    if (!raw.endsWith("\n")) invalid();
    const lines = raw.slice(0, -1).split("\n");
    if (lines.length < 1 || lines.length > 2) invalid();
    const pending = parseEnvelope(lines[0] as string);
    exactKeys(pending, ["schemaVersion", "state", "databasePathDigest", "migrationId", "source"]);
    if (
      pending.schemaVersion !== 1 ||
      pending.state !== "pending" ||
      pending.databasePathDigest !== pathDigest(snapshotPath) ||
      typeof pending.migrationId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        pending.migrationId,
      )
    )
      invalid();
    if (pending.source !== null) {
      if (!isObject(pending.source)) invalid();
      exactKeys(pending.source, ["size", "mtimeMs", "device", "inode", "sha256"]);
      if (
        !Number.isSafeInteger(pending.source.size) ||
        (pending.source.size as number) < 0 ||
        typeof pending.source.mtimeMs !== "number" ||
        !Number.isFinite(pending.source.mtimeMs) ||
        typeof pending.source.device !== "string" ||
        !/^\d+$/u.test(pending.source.device) ||
        typeof pending.source.inode !== "string" ||
        !/^\d+$/u.test(pending.source.inode) ||
        !isDigest(pending.source.sha256)
      )
        invalid();
    }
    const pendingChecksum = digest(pending);
    let committed: Record<string, unknown> | undefined;
    if (lines[1] !== undefined) {
      committed = parseEnvelope(lines[1]);
      exactKeys(committed, ["schemaVersion", "state", "pendingChecksum", "bootstrapChecksum"]);
      if (
        committed.schemaVersion !== 1 ||
        committed.state !== "committed" ||
        committed.pendingChecksum !== pendingChecksum ||
        !isDigest(committed.bootstrapChecksum)
      )
        invalid();
    }
    // Reflush a valid witness before allowing any database use (also covers a prior sync failure).
    await handle.sync();
    await syncParent(snapshotPath);
    return {
      pending: pending as unknown as PendingMigration,
      pendingChecksum,
      committed: committed as unknown as CommittedMigration | undefined,
    };
  } finally {
    await handle.close();
  }
}

export async function assertDirectJobMigrationSource(
  snapshotPath: string,
  state: DirectJobMigrationState,
): Promise<void> {
  if (canonicalJson(await sourceIdentity(snapshotPath)) !== canonicalJson(state.pending.source)) {
    throw new Error("Direct job pending migration source identity changed");
  }
}

/** Caller holds SQLite's writer lock; COMMIT of the initial import must precede this. */
export async function commitDirectJobMigration(
  snapshotPath: string,
  state: DirectJobMigrationState,
  bootstrapChecksum: string,
): Promise<void> {
  const current = await readDirectJobMigration(snapshotPath);
  if (current === undefined || current.pendingChecksum !== state.pendingChecksum) invalid();
  if (current.committed !== undefined) {
    if (current.committed.bootstrapChecksum !== bootstrapChecksum) invalid();
    return;
  }
  const committed: CommittedMigration = {
    schemaVersion: 1,
    state: "committed",
    pendingChecksum: state.pendingChecksum,
    bootstrapChecksum,
  };
  const handle = await open(directJobMigrationPath(snapshotPath), "r+");
  try {
    const offset = (await handle.stat()).size;
    const bytes = Buffer.from(`${envelope(committed)}\n`, "utf8");
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written, offset + written);
      if (result.bytesWritten === 0)
        throw new Error("Direct job migration witness write was incomplete");
      written += result.bytesWritten;
    }
    // In-place append avoids a pending->committed rename/directory durability window on Windows.
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sourceIdentity(path: string): Promise<SourceIdentity | null> {
  let before: Awaited<ReturnType<typeof stat>>;
  try {
    before = await stat(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!before.isFile()) throw new Error("Direct job legacy source is not a regular file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino ||
    before.dev !== after.dev
  )
    throw new Error("Direct job legacy source changed while hashing");
  return {
    size: after.size,
    mtimeMs: after.mtimeMs,
    device: String(after.dev),
    inode: String(after.ino),
    sha256: hash.digest("hex"),
  };
}

async function syncParent(snapshotPath: string): Promise<void> {
  // Node cannot open/FlushFileBuffers a Windows directory. The witness itself is always synced.
  if (process.platform === "win32") return;
  const directory = await open(dirname(directJobMigrationPath(snapshotPath)), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function pathDigest(snapshotPath: string): string {
  const path = `${resolve(snapshotPath)}.sqlite`;
  return createHash("sha256")
    .update(process.platform === "win32" ? path.toLowerCase() : path)
    .digest("hex");
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function envelope(payload: unknown): string {
  return canonicalJson({ payload, checksum: digest(payload) });
}

function parseEnvelope(line: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(line);
  if (!isObject(parsed)) invalid();
  exactKeys(parsed, ["payload", "checksum"]);
  if (
    !isObject(parsed.payload) ||
    !isDigest(parsed.checksum) ||
    digest(parsed.payload) !== parsed.checksum
  )
    invalid();
  // Reject duplicate keys and noncanonical/ambiguous encodings as malformed state.
  if (canonicalJson(parsed) !== line) invalid();
  return parsed.payload;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    invalid();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function invalid(): never {
  throw new Error("Direct job external migration state is invalid");
}
