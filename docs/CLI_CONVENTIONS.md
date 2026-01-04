# CLI conventions

This document captures CLI behavior expectations for `ynac`.

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

## Dates & locale

- Transaction dates are UTC date-only (`YYYY-MM-DD`) in the API.
- For display, render dates as they were given by the API.

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

## Exit codes (initial)

- `0` success
- `2` usage error (invalid flags, missing required args)
- `3` unauthorized (missing/invalid token)
- `4` not found (budget, tx id, category name)
- `6` rate limited
- `70` internal error
