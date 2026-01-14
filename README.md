# nab

`nab` is a Bun + TypeScript CLI for interacting with your **YNAB** (You Need A Budget) account via the **YNAB API**.

It is intentionally designed as a **"porcelain" CLI for AI agents**:
- high-level, human/agent-meaningful subcommands (approve, categorize, add memo, clear, delete, etc.)
- **safe defaults** for mutations (explicit IDs required, `--dry-run` first-class, `--yes` to apply)
- **scripting-friendly output** (JSON/TSV/ids)
- local SQLite for **history/journaling**

Example list filters:
- `nab tx list --account-id <id> --format json`
- `nab tx list --uncategorized --format json`
- `nab tx list --unapproved --format json`

## Quick start

```bash
bun install

# Set your tokens (Personal Access Tokens)
nab auth token add "<PAT1>"
nab auth token add "<PAT2>"


# Set default budget for this machine
nab config set --budget-id 06443689-ec9d-45d9-a37a-53dc60014769

# Or use environment variables
export NAB_TOKENS="<PAT1>,<PAT2>"
export NAB_BUDGET_ID=06443689-ec9d-45d9-a37a-53dc60014769

# Show config (redacts tokens)
nab config show

# See available commands
nab --help
```

## OAuth (optional)

`nab` also supports YNAB OAuth (Authorization Code Grant) with a localhost redirect.

```bash
# Initialize OAuth (prints redirect URI + saves client id/secret)
nab auth oauth init

# Login (starts local server + opens browser)
nab auth oauth login
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

## Logging

`nab` writes structured NDJSON logs to a local file (no stdout/stderr noise by default).
Locations:
- macOS: `~/Library/Logs/nab/nab.log`
- Linux: `~/.local/state/nab/nab.log` (or `$XDG_STATE_HOME/nab/nab.log`)
- Windows: `%LOCALAPPDATA%\\nab\\Logs\\nab.log`

Override with env vars: `NAB_LOG_DIR`, `NAB_LOG_FILE`, `NAB_LOG_LEVEL`, `NAB_LOG_DISABLE`.

## Docs

- `docs/YNAB_PRIMER.md` — YNAB domain + API basics
- `docs/ARCHITECTURE.md` — layered architecture + module boundaries
- `docs/CLI_CONVENTIONS.md` — output, errors, exit codes, agent rules
- `docs/BEADS.md` — bead-by-bead plan (incremental work breakdown)
- `docs/TESTING.md` — unit + integration testing guidance
