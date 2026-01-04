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
- running `ynac --help` works
- `ynac config show --format json` prints valid JSON
- usage errors return exit code 2

Key files:
- `src/io/...`
- `src/util/exitCodes.ts`
- `src/cli/root.ts`

## Bead 2 — Config resolution
Goal: support token + default budget id loading.
Scope:
- config file read/write (already partially implemented)
- resolve `YNAC_TOKEN` / `YNAC_BUDGET_ID` env overrides
- resolve `--budget-id` override

Acceptance criteria:
- `ynac config set --token ...`
- `ynac config set --budget-id ...`
- any command can resolve an effective token + budget id (or fail with actionable error)

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

## Bead 4 — SQLite foundation (journal + cache schema)
Goal: add sqlite db with migrations.
Scope:
- create/open sqlite file in config dir
- migrations to create:
  - `history_actions`
  - `cache_entities`
  - `cache_state` (server_knowledge per budget/resource)

Acceptance criteria:
- db initializes automatically
- unit test opens db in a temp dir and runs migrations

Key files:
- `src/journal/db.ts`
- `src/journal/migrations.ts`
- `src/cache/**`

## Bead 5 — Read-only commands (agent-safe)
Goal: let agents query budgets and transactions.
Commands:
- `ynac budget list`
- `ynac account list`
- `ynac category list`
- `ynac payee list`
- `ynac tx list`
- `ynac tx get --id ...`

Acceptance criteria:
- outputs support `--format json`
- list commands can run with only token+budget id

## Bead 6 — Transaction mutation operations (v1 core)
Goal: implement the common transaction operations as high-level CLI commands.
Commands (all must support `--dry-run` and require `--yes` to apply):
- `ynac tx approve --id ...`
- `ynac tx unapprove --id ...`
- `ynac tx delete --id ...`
- `ynac tx category set --id ... --category-id ... | --category-name ...`
- `ynac tx category clear --id ...`
- `ynac tx memo get --id ...`
- `ynac tx memo set --id ... --memo ...`
- `ynac tx memo clear --id ...`
- `ynac tx flag set --id ... --color ...`
- `ynac tx flag clear --id ...`
- `ynac tx cleared set --id ... --status cleared|uncleared|reconciled`
- `ynac tx date set YYYY-MM-DD --id ...`
- `ynac tx payee set --id ... --payee-id ... | --payee-name ...`
- `ynac tx amount set --id ... --amount ...` (single id only)
- `ynac tx account set --id ... --account-id ... | --account-name ...` (error on transfers)

Acceptance criteria:
- idempotent operations: re-running same command does not change anything
- `--dry-run` prints a patch-like preview and does not mutate
- ambiguous name resolution returns error with candidates

## Bead 7 — History journaling for applied actions
Goal: record what `ynac` did locally for later inspection and potential revert.
Scope:
- write a `history_actions` record for every applied mutation
- record:
  - timestamp
  - command name + argv (normalized)
  - affected tx ids
  - forward patch
  - inverse patch (best effort)

Commands:
- `ynac history show` (new)

Acceptance criteria:
- after a mutation, `history show` lists it
- history includes enough data to support a future revert

## Bead 8 — Local cache + delta sync
Goal: reduce API calls; support fast agent loops.
Scope:
- cache transactions/accounts/categories/payees in sqlite
- use `server_knowledge` + `last_knowledge_of_server` delta requests
- store per-resource `server_knowledge`
- read commands optionally served from cache (`--cached`)

Acceptance criteria:
- `ynac tx list --cached` works after `ynac cache sync`
- repeated syncs only fetch deltas

## Bead 9 — Integration tests (real YNAB budget)
Goal: ensure end-to-end behavior against the test budget.
Scope:
- test setup helper that creates a throwaway transaction in the test budget
- run CLI commands against that tx (approve, memo, category, cleared, delete)
- ensure `--dry-run` never mutates

Acceptance criteria:
- tests pass when `YNAC_TOKEN` and `YNAC_BUDGET_ID` are set
- tests fail fast with clear error if budget id is not the required test budget

