# nab

`nab` is a Bun + TypeScript CLI for interacting with your **YNAB** (You Need A Budget) account via the **YNAB API**.

It is intentionally designed as a **"porcelain" CLI for AI agents**:
- high-level, human/agent-meaningful subcommands (approve, categorize, add memo, clear, delete, etc.)
- **safe defaults** for mutations (explicit IDs required, `--dry-run` first-class, `--yes` to apply)
- **scripting-friendly output** (JSON/TSV/ids)
- local SQLite for **history/journaling**

Example list filters:
- `bunx @jameskraus/nab tx list --account-id <id> --format json`
- `bunx @jameskraus/nab tx list --only-uncategorized --format json`
- `bunx @jameskraus/nab tx list --only-unapproved --format json`
- `bunx @jameskraus/nab tx list --exclude-transfers --format json`

Agent-oriented attention queues:
- `bunx @jameskraus/nab review transactions --since-date 2026-07-01 --account-name-prefix "J " --limit 5 --format json`
- `bunx @jameskraus/nab budget status --month current --format json`

## Quick start

Requires Bun (https://bun.sh). Use `bunx @jameskraus/nab`.

```bash
# See available commands
bunx @jameskraus/nab --help

# Set your tokens (Personal Access Tokens)
bunx @jameskraus/nab auth token add "<PAT1>"
bunx @jameskraus/nab auth token add "<PAT2>"


# Set default budget for this machine
bunx @jameskraus/nab budget set-default --id 06443689-ec9d-45d9-a37a-53dc60014769

# Or use environment variables
export NAB_TOKENS="<PAT1>,<PAT2>"
export NAB_BUDGET_ID=06443689-ec9d-45d9-a37a-53dc60014769

# Show effective budget id
bunx @jameskraus/nab budget current
```

## Mislinked transfers

Detect likely mislinked transfer pairs (phantom transfers) and fix them.

```bash
# Review likely mislinked transfers
bunx @jameskraus/nab review mislinked-transfers --format table

# Fix one (dry-run first)
bunx @jameskraus/nab fix mislinked-transfer --anchor <ref|id> --phantom <ref|id> --orphan <ref|id> --dry-run
```

## Transaction review

Get one deduplicated queue of unapproved or uncategorized transactions. Counts are calculated
before `--limit`, transactions carry one or both issue codes, and transfers/splits are identified
so an agent can handle them safely.

```bash
bunx @jameskraus/nab review transactions \
  --since-date 2026-07-01 \
  --account-name-prefix "J " \
  --limit 5 \
  --format json
```

`--since-date` is required, so an agent never relies on a hidden review window.

## Batch transaction updates

Use `nab tx apply --file changes.json` to combine different category, memo, and approval changes
for multiple regular transactions. In a local checkout, build with `bun run build` and use
`./dist/nab`.

```json
{
  "transactions": [
    {
      "id": "10000000-0000-4000-8000-000000000001",
      "category_name": "Groceries",
      "memo": "Weekly shop",
      "approved": true
    },
    {
      "id": "10000000-0000-4000-8000-000000000002",
      "approved": true
    }
  ]
}
```

Replace the example IDs with the exact transaction UUIDs you reviewed, then run:

```bash
nab tx apply --file changes.json --dry-run --format json
nab tx apply --file changes.json --yes --format json
```

- Each row needs a unique UUID and at least one supported field. Use either `category_id` (UUID
  or `null`) or an unambiguous `category_name`. Omitted fields stay unchanged.
- `memo` accepts up to 500 characters; `null` or `""` clears it. `approved` accepts `true` or `false`.
  The CLI does not automatically approve categorization; include `approved: true` when authorized.
- Transfers, splits, deleted transactions, duplicate IDs, and unknown fields are rejected before
  any write. This command does not change payees, dates, amounts, accounts, or budget assignments.
- Nab reads each target once, resolves all category names with one category lookup if needed,
  skips no-ops, and sends one bulk update for the remaining rows.
- JSON results stay in input order. `transaction` is the actual YNAB response for an updated row,
  or the freshly read current state for a no-op/dry-run. Its amounts use YNAB milliunits.
- An incomplete or interrupted response causes readback only for uncertain IDs, without replaying
  the write. Any still `unverified` row causes a nonzero exit with per-ID results. Inspect those
  results before retrying; a batch may be partly applied.

Successful batches create one history action with per-ID inverse patches. If verification fails,
confirmed rows remain reversible and unverified rows are stored separately for inspection.
`history revert` only reverts confirmed rows; it cannot automatically undo unverified rows.
No-op and dry-run batches add no history action. Use `history list --format json` to find an action,
then `history revert --id <ACTION_ID> --dry-run` or `--yes`.

## Budget health and assignment

Show Ready to Assign plus categories that are overspent or behind a native YNAB target:

```bash
bunx @jameskraus/nab budget status --month current --format table
```

Set one category's absolute assigned total. Always dry-run first, then apply with the exact
current value as a compare-before-write guard:

```bash
bunx @jameskraus/nab category set-assigned \
  --id <CATEGORY_ID> \
  --month 2026-07-01 \
  --amount 250.00 \
  --dry-run

bunx @jameskraus/nab category set-assigned \
  --id <CATEGORY_ID> \
  --month 2026-07-01 \
  --amount 250.00 \
  --expected-current 100.00 \
  --yes
```

Applied assignments are verified against YNAB and recorded in local history. By default, `nab`
rejects negative assigned totals and changes that would make Ready to Assign negative in the
future-most funded month. If a write response is interrupted, `nab` reads the category back before
deciding whether the change failed or must be journaled as applied.

## OAuth (optional)

`nab` also supports YNAB OAuth (Authorization Code Grant) with a localhost redirect.

```bash
# Initialize OAuth (prints redirect URI + saves client id/secret)
bunx @jameskraus/nab auth oauth init

# Login (starts local server + opens browser)
bunx @jameskraus/nab auth oauth login
```

## Development

- Runtime: **Bun**
- CLI framework: **yargs**
- Formatting/linting: **Biome**

```bash
bun run dev -- --help
bun test
bun run lint
```

## Publishing

1) Bump `package.json` version as needed.
2) `bunx npm publish`

## Logging

`nab` writes structured NDJSON logs to a local file (no stdout/stderr noise by default).
Locations:
- macOS: `~/Library/Logs/nab/nab.log`
- Linux: `~/.local/state/nab/nab.log` (or `$XDG_STATE_HOME/nab/nab.log`)
- Windows: `%LOCALAPPDATA%\\nab\\Logs\\nab.log`

Override with env vars: `NAB_LOG_DIR`, `NAB_LOG_FILE`, `NAB_LOG_LEVEL`.

## Docs

- `docs/YNAB_PRIMER.md` — YNAB domain + API basics
- `docs/ARCHITECTURE.md` — layered architecture + module boundaries
- `docs/CLI_CONVENTIONS.md` — output, errors, exit codes, agent rules
- `docs/BEADS.md` — bead-by-bead plan (incremental work breakdown)
- `docs/TESTING.md` — unit + integration testing guidance
