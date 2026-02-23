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

## Review summary

Get a high-level review of overspending, uncategorized transactions, and unapproved transactions.

```bash
# Overspent categories + uncategorized/unapproved transactions
bunx @jameskraus/nab review summary --format table

# Customize transaction window (default: last 30 days)
bunx @jameskraus/nab review summary --since-date 2026-01-01 --format json
```

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
