# Beads (incremental work plan)

We break work into **beads** (small vertical slices) so agents can implement, test, and land changes incrementally.

A bead should:
- produce a working, testable increment (even if incomplete overall)
- include docs and tests where appropriate
- avoid large refactors across many layers unless required

## Bead 0 — Repo scaffold (DONE in this zip)
Goal: establish the project skeleton, CLI command taxonomy (help only), and tooling.
Deliverables:
- Bun + TS project structure
- yargs CLI skeleton + placeholder commands
- Biome config + scripts
- docs skeleton

## Bead 1 — CLI output & error handling baseline
Goal: centralize formatting + exit code mapping.
Scope:
- `--format table|json|tsv|ids`
- consistent `stdout` vs `stderr`
- top-level error mapping to `ExitCode` codes

Acceptance criteria:
- running `bunx @jameskraus/nab --help` works
- `bunx @jameskraus/nab budget list --format json` prints valid JSON
- usage errors return exit code 2

Key files:
- `src/io/...`
- `src/util/exitCodes.ts`
- `src/cli/root.ts`

## Bead 2 — Config resolution
Goal: support tokens + default budget id loading.
Scope:
- config file read/write (already partially implemented)
- resolve `NAB_TOKENS` / `NAB_BUDGET_ID` env overrides
- resolve `--budget-id` override

Acceptance criteria:
- `bunx @jameskraus/nab auth token add <PAT>`
- `bunx @jameskraus/nab budget set-default --id <BUDGET_ID>`
- any command can resolve effective tokens + budget id (or fail with actionable error)

Key files:
- `src/config/**`
- `src/app/createAppContext.ts` (add)

## Bead 3 — YNAB API client wrapper
Goal: isolate YNAB SDK usage behind a thin client with consistent errors.
Scope:
- create `YnabClient` wrapper using the `ynab` npm package
- map common API errors to typed errors + exit codes
- establish request tracing hooks (for future journaling)

Acceptance criteria:
- can call `listBudgets()` and `listTransactions()` (raw)
- 401/404/429 become typed errors

Key files:
- `src/api/YnabClient.ts`
- `src/api/errors.ts`

## Bead 4 — SQLite foundation (journal schema)
Goal: add sqlite db with migrations.
Scope:
- create/open sqlite file in config dir
- migrations to create:
  - `history_actions`

Acceptance criteria:
- db initializes automatically
- unit test opens db in a temp dir and runs migrations

Key files:
- `src/journal/db.ts`
- `src/journal/migrations.ts`

## Bead 5 — Read-only commands (agent-safe)
Goal: let agents query budgets and transactions.
Commands:
- `bunx @jameskraus/nab budget list`
- `bunx @jameskraus/nab account list`
- `bunx @jameskraus/nab category list`
- `bunx @jameskraus/nab payee list`
- `bunx @jameskraus/nab tx list`
- `bunx @jameskraus/nab tx get --id ...`

Acceptance criteria:
- outputs support `--format json`
- list commands can run with only token+budget id

## Bead 6 — Transaction mutation operations (v1 core)
Goal: implement the common transaction operations as high-level CLI commands.
Commands (all must support `--dry-run` and require `--yes` to apply):
- `bunx @jameskraus/nab tx approve --id ...`
- `bunx @jameskraus/nab tx unapprove --id ...`
- `bunx @jameskraus/nab tx delete --id ...`
- `bunx @jameskraus/nab tx category set --id ... --category-id ... | --category-name ...`
- `bunx @jameskraus/nab tx category clear --id ...`
- `bunx @jameskraus/nab tx memo get --id ...`
- `bunx @jameskraus/nab tx memo set --id ... --memo ...`
- `bunx @jameskraus/nab tx memo clear --id ...`
- `bunx @jameskraus/nab tx flag set --id ... --color ...`
- `bunx @jameskraus/nab tx flag clear --id ...`
- `bunx @jameskraus/nab tx cleared set --id ... --status cleared|uncleared|reconciled`
- `bunx @jameskraus/nab tx date set YYYY-MM-DD --id ...`
- `bunx @jameskraus/nab tx payee set --id ... --payee-id ... | --payee-name ...`
- `bunx @jameskraus/nab tx amount set --id ... --amount ...` (single id only)
- `bunx @jameskraus/nab tx account set --id ... --account-id ... | --account-name ...` (error on transfers)

Acceptance criteria:
- idempotent operations: re-running same command does not change anything
- `--dry-run` prints a patch-like preview and does not mutate
- ambiguous name resolution returns error with candidates

## Bead 7 — History journaling for applied actions
Goal: record what `bunx @jameskraus/nab` did locally for later inspection and potential revert.
Scope:
- write a `history_actions` record for every applied mutation
- record:
  - timestamp
  - command name + argv (normalized)
  - affected tx ids
  - forward patch
  - inverse patch (best effort)

Commands:
- `bunx @jameskraus/nab history list` (new)

Acceptance criteria:
- after a mutation, `history list` lists it
- history includes enough data to support a future revert

## Bead 9 — Integration tests (real YNAB budget)
Goal: ensure end-to-end behavior against the test budget.
Scope:
- test setup helper that creates a throwaway transaction in the test budget
- run CLI commands against that tx (approve, memo, category, cleared, delete)
- ensure `--dry-run` never mutates

Acceptance criteria:
- tests pass when `NAB_TOKENS` and `NAB_BUDGET_ID` are set
- tests fail fast with clear error if budget id is not the required test budget
