# Transaction refs (short references)

## Goal

Provide short, human-friendly references for transactions so agents and humans can
refer to items in conversation without copying UUIDs. Refs are local to the
machine and are valid for a limited time window.

This document specifies the ref system design and a concrete implementation plan
for this codebase.

## Goals

- Short, stable refs for transactions (for at least 30 days).
- Deterministic ref issuance with no collisions or reuse.
- Fast lookup in both directions (uuid <-> ref).
- Storage bounded by a rolling window of recent activity.
- Use existing SQLite journal database and Bun's sqlite driver.

## Non-goals

- Refs are not synced across machines.
- Refs are not permanent identifiers.
- No YNAB data changes.
- No ref system for entities other than transactions (for now).

## Design summary

We use a lease table in SQLite that maps monotonically increasing integers to
transaction UUIDs. The integer is encoded as Crockford Base32 to create the
short ref. Rows expire after 30 days; expired rows are deleted on access.

There is no reuse pool. We always mint a new ref for a new UUID once the old
mapping has expired. The encoder uses `Number.MAX_SAFE_INTEGER` as a practical
ceiling.

## Encoding

Alphabet (Crockford Base32):

- 0123456789ABCDEFGHJKMNPQRSTVWXYZ

Rules:

- Encode output in uppercase.
- Decode input case-insensitively (uppercase before decoding).
- Optionally accept user input aliases:
  - O -> 0
  - I or L -> 1
- Reject any other characters.

Length growth (base32):

- 3 chars: up to 32^3 - 1 = 32,767
- 4 chars: up to 32^4 - 1 = 1,048,575
- 5 chars: up to 32^5 - 1 = 33,554,431

## Lease policy

- Lease duration: 30 days (in ms).
- A mapping is live when expires_at_ms > now_ms.
- Expired rows are deleted at the start of every ref operation.
- On access, we update last_used_at_ms and extend expires_at_ms to now + lease
  so active refs remain live.

## SQLite schema

Table name: ref_lease

```sql
CREATE TABLE IF NOT EXISTS ref_lease (
  n               INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid            TEXT    NOT NULL UNIQUE,
  assigned_at_ms  INTEGER NOT NULL,
  last_used_at_ms INTEGER NOT NULL,
  expires_at_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ref_lease_expires
ON ref_lease(expires_at_ms);
```

Notes:

- No code column is needed because ref = encode(n).
- AUTOINCREMENT prevents reuse after deletes.
- Table lives in the existing journal DB (nab.sqlite).

## Operations

All ref operations run in a write transaction to ensure cleanup + mutation is
atomic and race-free.

### Cleanup (always first)

```sql
DELETE FROM ref_lease WHERE expires_at_ms <= :now_ms;
```

### UUID -> ref

Goal: return a live ref for a UUID, or mint a new one if missing.

Transaction flow:

```sql
BEGIN IMMEDIATE;

DELETE FROM ref_lease WHERE expires_at_ms <= :now_ms;

UPDATE ref_lease
SET last_used_at_ms = :now_ms,
    expires_at_ms = :now_ms + :lease_ms
WHERE uuid = :uuid
RETURNING n;
```

If row exists:

- encode(n) -> ref
- COMMIT

If no row:

```sql
INSERT INTO ref_lease (uuid, assigned_at_ms, last_used_at_ms, expires_at_ms)
VALUES (:uuid, :now_ms, :now_ms, :now_ms + :lease_ms)
RETURNING n;
```

- encode(n) -> ref
- COMMIT

### Ref -> UUID

Goal: resolve ref to UUID if live, else return not found.

Steps:

1) Decode ref to n (fail fast if invalid).
2) Transaction:

```sql
BEGIN IMMEDIATE;

DELETE FROM ref_lease WHERE expires_at_ms <= :now_ms;

UPDATE ref_lease
SET last_used_at_ms = :now_ms,
    expires_at_ms = :now_ms + :lease_ms
WHERE n = :n
RETURNING uuid;
```

If row exists, return uuid. If not, ref is unknown or expired.

### Batch UUID -> ref (needed for tx list)

We want to avoid per-transaction transactions when listing. Plan for a
batch helper:

- Begin transaction
- Cleanup expired
- Select existing rows for all UUIDs
- Insert missing UUIDs
- Update last_used/expires for all touched rows
- Return a map uuid -> ref

Implementation detail: bun:sqlite uses positional parameters, so we will build
IN clauses with dynamic placeholders.

## CLI integration

### Where refs are stored

Use the existing journal DB opened by `openJournalDb` at
`getSqlitePath()` (nab.sqlite). No new file.

### New ref module

Add a small ref subsystem:

- `src/refs/crockford.ts`:
  - encodeBase32(n)
  - decodeBase32(code)
  - normalizeRefInput(code)
- `src/refs/refLease.ts` (or `src/journal/refs.ts`):
  - getOrCreateRef(db, uuid, nowMs?) -> string
  - getOrCreateRefs(db, uuids, nowMs?) -> Map<string, string>
  - resolveRef(db, ref, nowMs?) -> string | null

### Output changes (tx list / tx get)

Refs should always be included so conversational workflows have them without
extra flags.

- Default behavior (no flag required):
  - table/tsv output includes a `Ref` column (first column)
  - json output includes `ref` on each transaction object

No opt-out flag is planned.

### Input changes (mutation commands)

Allow users to reference transactions by ref:

- Add `--ref` (repeatable) to all tx mutation commands
  (`approve`, `unapprove`, `delete`, `memo set/clear`, `category set/clear`,
   `payee set`, `cleared set`, `date set`, `amount set`, `account set`).
- `--id` and `--ref` are **mutually exclusive**.
- Validate that **exactly one** selector type is provided.
- On invalid or expired ref, return a clear error:
  - "Ref not found or expired. Re-run `nab tx list`."

For tx get, allow `--ref` or `--id` (mutually exclusive).

### DB requirement changes

Ref lookups require the DB. We will:

- Ensure tx list and tx get open the DB (refs are always included).
- Given `defineCommand` requirements are static, the simplest option is to
  mark tx list and tx get with `db: true` and accept the local DB usage for
  read-only commands.

## Error handling

- Invalid ref format -> error with hint about allowed characters.
- Unknown/expired ref -> error with hint to re-run list.
- If DB is unavailable, return a local-state error (no YNAB mutation).

## Tests

Unit tests:

- `refs/crockford`:
  - round-trip encode/decode
  - invalid characters
  - alias normalization (O/I/L)
- `refLease`:
  - inserts new ref
  - returns same ref for same UUID within lease
  - expires after lease and mints a new ref
  - cleanup removes expired
  - batch mapping returns refs for all UUIDs

CLI tests:

- tx list (default):
  - table output includes Ref column
  - json includes ref field
- mutation commands accept `--ref` and resolve to ids

DB migration tests:

- `openJournalDb` creates `ref_lease`
- schema version advances to new migration id

## Documentation updates

When implemented, update:

- `docs/CLI_CONVENTIONS.md` (new flags and ref behavior)
- `docs/ARCHITECTURE.md` (journal DB schema update)

## Implementation plan

1) Add ref schema migration
   - Add migration `002_ref_lease` in `src/journal/migrations.ts`.
   - Update `tests/unit/journal/db.test.ts` expected version and table list.

2) Implement Crockford Base32 codec
   - New module in `src/refs/crockford.ts`.
   - Provide encode/decode + normalization.
   - Add unit tests.

3) Implement ref lease store
   - New module `src/refs/refLease.ts` (or `src/journal/refs.ts`).
   - Functions: cleanup, getOrCreateRef, getOrCreateRefs, resolveRef.
   - Use `BEGIN IMMEDIATE` transactions and `RETURNING`.
   - Add unit tests with temp sqlite DB.

4) Add ref mapping to tx list / tx get outputs
   - Always resolve refs for list and get outputs.
   - For JSON output: include `ref` field.
   - For table/tsv output: add `Ref` column (first column).
   - Update CLI unit tests for list output with default refs.

5) Add `--ref` support to mutation commands
   - Add `--ref` option to relevant tx mutation commands.
   - Convert refs to ids via ref lease store and merge with `--id` values.
   - Update validation and error messaging.
   - Add unit tests for selector normalization and invalid refs.

6) Docs
   - Update `docs/CLI_CONVENTIONS.md` with new options.
   - Update `docs/ARCHITECTURE.md` with new table and ref module.

7) Verify
   - Run `bun test`.
   - Run `bun run lint` and `bun run format` if needed.

8) Beads
   - Create beads issues for each milestone above and close when done.
