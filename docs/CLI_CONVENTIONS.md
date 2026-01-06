# CLI conventions

This document captures CLI behavior expectations for `nab`.

## Compatibility policy

We do not preserve backwards compatibility in the current greenfield phase.

## Output

- Default output is **human-friendly** when running in a TTY.
- When `--format json` is specified, output must be stable enough for machines to parse, but **schema stability is not guaranteed** (agents can consult `--help`).
- `stdout` is reserved for the primary command output.
- `stderr` is reserved for errors and diagnostics.

Supported formats:
- `table` (default, TTY)
- `json` (preferred for agents)
- `tsv` (scripting)
- `ids` (just ids, newline-delimited)

Examples:
- `nab config show --format json`
- `nab config show --format tsv`

## Dates & locale

- Transaction dates are UTC date-only (`YYYY-MM-DD`) in the API.
- For display, render dates as they were given by the API.

## Config resolution

Precedence (highest to lowest):
1. CLI flags (`--budget-id`)
2. Environment variables (`NAB_TOKENS`, `NAB_BUDGET_ID`, `NAB_CONFIG_DIR`)
3. Config file (`nab config set`)

## Read-only commands

Read-only commands never mutate YNAB data and are safe for agents.

Budgets:
- `nab budget list [--format table|json|tsv|ids]`

Accounts:
- `nab account list [--format ...]` (requires budget id)

Categories:
- `nab category list [--format ...]` (requires budget id)

Payees:
- `nab payee list [--format ...]` (requires budget id)

Transactions:
- `nab tx list [--since-date YYYY-MM-DD] [--account-id <id>] [--uncategorized] [--format ...]`
- `nab tx get --id <transaction-id> [--format ...]`
- `nab tx create --account-id <id> --date YYYY-MM-DD --amount <amount> [--payee-id ...] [--category-id ...] [--memo ...] [--cleared ...] [--approved true|false] [--flag-color ...] [--format ...] [--dry-run] [--yes]`

Examples:
- `nab budget list --format tsv`
- `nab account list --format ids`
- `nab tx list --since-date 2026-01-01 --uncategorized --format json`
- `nab tx get --id 12345 --format json`

## Mutations

All mutating commands must:
- require explicit `--id` selection (no implicit filters)
- support `--dry-run` (preview)
- require `--yes` to apply in non-interactive contexts
- be **idempotent** (setting a field to its current value is a no-op)

## Errors

- Use non-zero exit codes.
- Include actionable messages (what failed + how to fix).
- For usage errors, show a short hint to use `--help`.

## Exit codes

- `0` success
- `1` any failure (usage or runtime)
