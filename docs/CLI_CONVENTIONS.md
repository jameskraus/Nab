# CLI conventions

This document captures CLI behavior expectations for `nab`.
Requires Bun (https://bun.sh). Examples use `bunx @jameskraus/nab`.

## Compatibility policy

We do not preserve backwards compatibility in the current greenfield phase.

## Output

- Default output is **human-friendly** when running in a TTY.
- When `--format json` is specified, output must be stable enough for machines to parse, but **schema stability is not guaranteed** (agents can consult `--help`).
- `stdout` is reserved for the primary command output.
- `stderr` is reserved for errors and diagnostics.
- Monetary values are formatted using the budget's `currency_format` by default.
  - JSON includes display fields like `amount_display` and raw milliunits with a `raw_` prefix.

Supported formats:
- `table` (default, TTY)
- `json` (preferred for agents)
- `tsv` (scripting)
- `ids` (just ids, newline-delimited)

Examples:
- `bunx @jameskraus/nab budget list --format json`
- `bunx @jameskraus/nab budget list --format tsv`

## Dates & locale

- Transaction dates are UTC date-only (`YYYY-MM-DD`) in the API.
- For display, render dates as they were given by the API.

## Config resolution

Precedence (highest to lowest):
1. CLI flags (`--auth`, `--budget-id`)
2. Environment variables (`NAB_AUTH_METHOD`, `NAB_TOKENS`, `NAB_BUDGET_ID`, `NAB_CONFIG_DIR`, `NAB_OAUTH_CLIENT_ID`, `NAB_OAUTH_CLIENT_SECRET`, `NAB_OAUTH_SCOPE`)
3. Config file (written by `nab auth` commands and `bunx @jameskraus/nab budget set-default`)

## Read-only commands

Read-only commands never mutate YNAB data and are safe for agents.

Budgets:
- `bunx @jameskraus/nab budget list [--format table|json|tsv|ids]`
- `bunx @jameskraus/nab budget set-default --id <budget-id>` (local-only)

Accounts:
- `bunx @jameskraus/nab account list [--format ...]` (requires budget id)

Categories:
- `bunx @jameskraus/nab category list [--format ...]` (requires budget id)

Payees:
- `bunx @jameskraus/nab payee list [--format ...]` (requires budget id)

Transactions:
- `bunx @jameskraus/nab tx list [--since-date YYYY-MM-DD] [--account-id <id>] [--only-uncategorized] [--only-unapproved] [--only-transfers] [--exclude-transfers] [--format ...]`
- `bunx @jameskraus/nab tx get --id <transaction-id> [--format ...]`
- `bunx @jameskraus/nab tx create --account-id <id> --date YYYY-MM-DD --amount <amount> [--payee-id ...] [--category-id ...] [--memo ...] [--cleared ...] [--approved true|false] [--flag-color ...] [--format ...] [--dry-run] [--yes]`

Notes:
- `--only-uncategorized` and `--only-unapproved` are mutually exclusive.
- `--only-transfers` and `--exclude-transfers` are mutually exclusive.
- `--uncategorized` and `--unapproved` are deprecated aliases.
- Transfer transactions render category as `n/a - transfer` in table/tsv output; JSON keeps `category_id` and `category_name` as null.

History (local-only):
- `bunx @jameskraus/nab history list [--limit <n>] [--since <ISO 8601>] [--format ...]`
- `bunx @jameskraus/nab history show <id-or-index> [--format ...]`

Examples:
- `bunx @jameskraus/nab budget list --format tsv`
- `bunx @jameskraus/nab account list --format ids`
- `bunx @jameskraus/nab tx list --account-id 123 --format json`
- `bunx @jameskraus/nab tx list --since-date 2026-01-01 --only-uncategorized --format json`
- `bunx @jameskraus/nab tx list --only-unapproved --format json`
- `bunx @jameskraus/nab tx list --exclude-transfers --format json`
- `bunx @jameskraus/nab tx get --id 12345 --format json`

## Mutations

All mutating commands must:
- require explicit `--id` selection (no implicit filters)
- support `--dry-run` (preview)
- require `--yes` to apply in non-interactive contexts
- be **idempotent** (setting a field to its current value is a no-op)

History reverts:
- `bunx @jameskraus/nab history revert --id <history-id> [--format ...] [--dry-run] [--yes]`

## Errors

- Use non-zero exit codes.
- Include actionable messages (what failed + how to fix).
- For usage errors, show a short hint to use `--help`.

## Exit codes

- `0` success
- `1` any failure (usage or runtime)
