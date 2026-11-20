# Direct-job incremental storage

Durable `DirectJobStore` uses Node's built-in `node:sqlite` (the package already
requires Node >=24.14.0). In-memory stores keep their existing API and behavior.
`store.snapshotPath` still names the legacy JSON migration source;
`store.databasePath` names its authoritative `${snapshotPath}.sqlite` sidecar.
No native arguments or raw owner/conversation/session/idempotency identities are
stored. IDs, fingerprints, target contracts, complete results and error envelopes
are preserved.

## Transactions and recovery

Each transition updates one indexed job and checksummed revision/count metadata
in a SQLite transaction, using WAL and `synchronous=FULL`. Capacity pruning, when
explicitly configured, is in the same transaction as insertion. The default has
no job or result cap. Same-process opens share one serialized core; `close()`
releases a handle and closes SQLite after the last handle's pending work finishes.
Use only one active gateway/daemon for a ledger: opening it in a fresh process
performs restart fencing, not live-reader attachment.

Startup verifies SQLite integrity, every row's checksum and indexed projection,
and the metadata checksum/count. It then transactionally fences queued work as
cancelled and running work as `outcome_unknown`. Existing terminal outcomes remain
unchanged. Nothing is replayed. Point lookups use the primary key; owner-scoped
list pages use indexed keyset pagination with the existing cursor encoding and
stale/scope/status validation.

## One-time legacy migration

The permanent `${snapshotPath}.sqlite.migration` witness is independent of the
SQLite/WAL files. It is an append-only, checksummed two-record protocol:

1. Before creating SQLite, write and sync a **pending** record binding a random
   migration identity, the database path digest and the legacy source's raw
   SHA-256, size, device/inode and modification time (or its initial absence).
2. Commit schema, streaming import and a checksummed bootstrap seal together in
   SQLite. The seal binds the pending record and initial revision/count/checksum.
3. Under SQLite's writer lock, append and sync a **committed** record binding that
   seal. No restart fencing or public operation is admitted before this succeeds.

An interrupted import can retry from an unchanged source when the witness is
pending and SQLite is missing, zero-length or schema-empty. A valid committed
initial import with a pending witness can finalize publication, but advanced
metadata is rejected as unsealed post-migration writes. A committed witness makes
missing, zero-length, corrupt or incomplete SQLite fail closed, never re-import.
Malformed/torn witnesses fail closed too. Existing SQLite without a witness is
not automatically adopted, including databases made by the earlier unmarked
implementation; audited recovery/adoption is a separate operator task.

JSON is read in 64KiB chunks, one job at a time, and the original canonical
snapshot checksum is computed incrementally. Metadata may occur before or after
the jobs array. Invalid JSON/schema/rows, duplicate IDs or checksum mismatch roll
back the import. The original JSON is never modified, renamed or removed. A
pending witness remains bound to its first source, so changing/replacing even a
bad source does not silently reset migration history. Source hashing adds bounded
streaming read passes; no full-ledger JSON parse is introduced.

Migration and startup memory scale with the largest individual record, plus
SQLite's bounded page cache (4MiB), parser/runtime overhead and requested list
page size, rather than total historical results. Startup still reads/checksums
all stored bytes. Very large individual results still require JSON parsing,
canonicalization and cloning; unbounded `list()` still returns all matching
results in memory, so callers should request bounded pages.

The regression fixture imports about 140MB across 5,000 jobs after forcibly
killing an in-progress migration, using a child with a 96MiB V8 old-space limit.
This is synthetic validation, not a production memory guarantee. Native SQLite,
V8 and runtime memory mean process RSS can exceed that heap limit substantially.

## Rollout, backup and rollback cautions

This source change does not restart/deploy a gateway or touch live data. Stop the
old writer before an authorized rollout, back up its original JSON, and allow
space for the retained JSON, SQLite database and migration WAL simultaneously.
Do not run the JSON-writing binary concurrently with the SQLite binary.

After new SQLite writes, the retained JSON is stale. Simply reverting to the old
binary would lose those newer jobs/results and could invalidate idempotency.
No automatic downgrade/export is implemented: retain the SQLite ledger for a
compatible reader or arrange a verified, stopped-writer export before rollback.
For backups, preserve the external witness along with a SQLite-consistent backup
with the writer stopped; do not copy only the main `.sqlite` file while a WAL
contains committed changes. Witnesses bind the resolved database path, so moving
a backup to another location requires audited rebinding, not automatic import.
Never remove/reset the witness or SQLite/WAL to force re-import from stale JSON.

Storage durability relies on SQLite and the filesystem honoring synchronization;
the tests inject process termination and transaction errors, not hardware power
loss or actual disk-full conditions. `node:sqlite` emits an experimental warning
on the tested Node 24.14.0 runtime.

Witness files are flushed with `FileHandle.sync()`. Committed publication appends
in place rather than renaming, avoiding a Windows pending-to-committed directory
entry replacement. Parent directories are synced on non-Windows systems; Node
cannot open/flush a Windows directory, so initial namespace durability still
depends on the filesystem/storage stack. Torn witness writes deliberately require
audited recovery instead of automatic repair. SHA-256 detects corruption, not a
maliciously recomputed checksum or restoration of an older valid witness/database.
Deleting both the independent witness and database leaves no local evidence of
their history; protect and back up both. No automatic downgrade, rollback export,
unmarked-database adoption or adversarial anti-rollback service is implemented.
