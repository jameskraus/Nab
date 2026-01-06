# Project guidelines (nab)

## Runtime & tooling
- Default to **Bun** (not Node).
  - `bun <file>` not `node`
  - `bun test` for tests
  - Bun auto-loads `.env` (do not add dotenv)
- Use **Biome** for linting/formatting (`bun run lint`, `bun run format`).
- Use Bun's built-in `bun:sqlite` for SQLite.

## CLI design constraints
- Binary name: `nab`
- Prefer **yargs** for argument parsing.
- Avoid positional args as much as possible (max one positional per command).
- Mutations must require explicit transaction IDs (no implicit selection/filter sets).
- All mutating commands must support:
  - `--dry-run` (no writes)
  - `--yes` (required to apply changes in non-interactive contexts)

## YNAB constraints for this repo
- Auth: **Personal Access Token** only (no OAuth).
- Dates: treat as **date-only** (`YYYY-MM-DD`).
- Transfers: moving transfers is out of scope for v1; attempting to move them should error.
- Splits: split creation/editing is out of scope for v1.

## Integration testing (REQUIRED budget)
All integration tests MUST target only this budget:
- Budget ID: `06443689-ec9d-45d9-a37a-53dc60014769`
- Web URL: https://app.ynab.com/06443689-ec9d-45d9-a37a-53dc60014769/budget/202601

Environment variables used by tests:
- `NAB_TOKENS` (required)
- `NAB_BUDGET_ID` (must equal the budget id above)
