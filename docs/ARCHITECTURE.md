# Architecture

`nab` is a layered CLI application.

## Naming conventions (rename to `nab`)

- **Binary name:** `nab`
- **Config dir name:** `nab` (OS-specific base path; e.g., `~/.config/nab` on Linux)
- **Env vars (primary):** `NAB_TOKENS`, `NAB_BUDGET_ID`, `NAB_CONFIG_DIR`, `NAB_AUTH_METHOD`, `NAB_OAUTH_CLIENT_ID`, `NAB_OAUTH_CLIENT_SECRET`, `NAB_OAUTH_SCOPE`
- **Migrations:** `schema_migrations` + `schema_version` track journal schema; we only support the latest layout.

## Layers & responsibilities

### 1) CLI / command layer (`src/cli/**`)
Responsibilities:
- parse args (yargs)
- route to command handlers
- validate flags (shape, mutual exclusivity)
- print results (via IO/formatting layer)
- map errors to exit codes
- declare per-command requirements (auth/budget/db/mutation/output) via `defineCommand`

Notes (current behavior):
- Read-only commands call the YNAB API directly via `ctx.ynab.*` (e.g., `budget list`, `account/category/payee list`, `tx list/get`).
- `tx list` uses the account-scoped endpoint when `--account-id` is provided and forwards server-side type filters (`uncategorized` / `unapproved`).
- `review transactions` performs both supported transaction-type requests inside one process,
  classifies/deduplicates them in the domain layer, and opens the local DB only for short refs.
- `budget status` reads one YNAB budget month and classifies Ready to Assign, overspending, and
  native target shortfalls.
- Mutating commands use the domain service layer for transaction or month-category operations.
- `tx apply --file` reads a JSON changeset and calls `TransactionService.applyChanges`. It records
  confirmed rows and unverified details before reporting an incomplete batch as an error.
- Commands without context requirements (e.g. `auth`, `budget set-default`) run without `appContext`.
- CLI handlers do not execute SQL directly; they call journal helpers in `src/journal/**`.

### 2) App context / composition root (`src/app/createAppContext.ts`)
Responsibilities:
- load config + resolve effective auth method, tokens, and budget id
- optionally open the journal DB
- create the YNAB API client
- handle OAuth token refresh when a token is required (auto-refresh if expiring)

This is the primary “middleware” entrypoint used by commands.

### 2.5) Logging subsystem (`src/logging/**`)
Responsibilities:
- initialize a per-run logger in `src/cli/index.ts`
- write NDJSON logs to a local file (pino)
- rotate + clean up old log files on startup
- redact token-shaped strings and known secret fields

Key environment variables:
- `NAB_LOG_DIR`, `NAB_LOG_FILE`, `NAB_LOG_LEVEL`
- `NAB_LOG_MAX_BYTES`, `NAB_LOG_RETENTION_DAYS`, `NAB_LOG_MAX_FILES`

### 3) Domain / service layer (`src/domain/**`)
Responsibilities:
- implement high-level mutation operations (approve, categorize, memo set/clear, cleared set, etc.)
- enforce invariants and safety checks (e.g. block transfers for `account set`)
- implement idempotency (no-op when already in desired state)
- produce inverse patches for journaling
- cache and resolve budget currency formats for display/input parsing
- build deterministic, API-independent transaction-review and budget-health read models
- set an absolute category assigned amount with compare-before-write, Ready-to-Assign protection,
  future-month protection, ambiguous-write reconciliation, and post-write verification

Key modules:
- `transactionChanges.ts`: strict per-ID changeset validation for category, memo, and approval.
- `TransactionService.ts`: shared fresh-read, no-op, patch, inverse-patch, and bulk-write machinery.
  `applyChanges` resolves category names once, rejects transfers/splits, and verifies the bulk
  response by ID and requested field values. Only uncertain IDs require additional GETs; writes
  are never replayed after an ambiguous response. Results include observed API transactions with
  raw milliunit amounts. Existing individual commands retain their own supported field scope.
- `transactionReview.ts`: unions the unapproved/uncategorized result sets, classifies
  regular/split/transfer rows, filters account-name prefixes, and limits after counting.
- `budgetHealth.ts`: classifies one month using API facts. `goal_under_funded` is authoritative for
  native target shortfalls; zero assigned alone is not an issue. Internal categories are excluded
  from the default actionable queue.
- `CategoryBudgetService.ts`: owns the month-category assignment safety contract. It guards the
  future-most month returned by the months endpoint because that is the authoritative Ready to
  Assign value once money has been assigned ahead.

### 4) API client layer (`src/api/**`)
Responsibilities:
- thin wrapper over YNAB API / SDK
- consistent error mapping (`401` -> Unauthorized, `404` -> NotFound, `429` -> RateLimited)
- retry/backoff (ONLY where safe)
- exposes account-scoped transaction listing and server-side transaction type filters
- exposes budget-month reads plus month-category reads and absolute assigned-value updates
- reads GET and bulk transaction-update response JSON without the pinned SDK's lossy model
  conversion, preserving null transaction fields and current API category fields such as `internal`
  and `goal_target_date`

Implementation notes:
- `SingleTokenYnabClient` wraps the SDK, enforces concurrency, retries GETs on rate-limit/network errors, and maps errors.
- `YnabClient` wraps multiple tokens, rotates on rate limits, disables unauthorized tokens, and exposes a unified client.

### 5) Persistence layer
- `src/config/**`: config file (tokens, OAuth config, default budget id, auth method, cached budget currency formats)
- `src/journal/**`: sqlite journal of applied actions

#### Journal DB schema
- `schema_migrations`: applied migration ids with timestamps
- `schema_version`: single-row pointer to the latest migration id
- `history_actions`: journal of applied mutations (payload + inverse patch)
- `ref_lease`: short transaction refs (local-only, time-bound)

History patch entries identify their resource. Existing transaction entries default to
`transaction`; category assignments use `month_category` plus an exact month. The storage schema
does not need a new table because payloads and inverse patches are JSON. Revert dispatches each
entry to the matching service and preserves compare-before-write protection for month categories.
For `tx.apply`, confirmed rows populate `patches` and `inversePatch`; unresolved results are stored
in `payload.unverified`, including attempted patches, original values, and observed state when
available. Revert operates only on the confirmed inverse patches. Dry-runs and all-no-op batches
do not create history entries.

### 6) Auth / OAuth flow (`src/auth/**`)
Responsibilities:
- build authorization URL
- run loopback server to capture code
- exchange/refresh tokens with YNAB OAuth endpoints

### 7) IO / formatting layer (`src/io/**`)
Responsibilities:
- formatting output in `table|json|tsv|ids`
- locale-friendly date formatting for humans
- currency formatting based on the budget's `currency_format`
- machine-friendly JSON for agents

## Per-command context requirements (`defineCommand`)

Commands declare their needs in `src/cli/command.ts` and `src/cli/options.ts`:
- `auth`: no `appContext` (config-only).
- `budget set-default`: no `appContext` (local config only).
- `history list/show`: `{ db: true }`.
- `history revert`: `{ auth: true, budget: "required", db: true, mutation: true }`.
- `budget list`: `{ auth: true }`.
- `budget current`: `{ budget: "required" }` (no token required).
- Read-only lists/gets (`account|category|payee list`, `tx list|get`, `tx memo get`):
  `{ auth: true, budget: "required" }`.
- `budget status`: `{ auth: true, budget: "required" }`.
- `review transactions`: `{ auth: true, budget: "required", db: true }` (DB is only for refs).
- Mutations (`tx *` except list/get/memo get): `{ auth: true, budget: "required", db: true, mutation: true }`.
- `category set-assigned`: `{ auth: true, budget: "required", db: true, mutation: true }`.

Mutation requirement meaning:
- `mutation: true` is reserved for commands that **write to YNAB**.
- Local config writes (auth config, `budget set-default`, `budget currency set`) are not treated as mutations.

Why this matters:
- `requireToken` triggers OAuth auto-refresh; commands with it set to `false` will not refresh.
- `createDb` controls journal availability (only mutations and `history` have DB).

## Request flow patterns (current)

### Read-only YNAB commands
`yargs` → `defineCommand` → `createAppContext` → CLI handler → `ctx.ynab.*` → output

### Mutation commands
`yargs` → `defineCommand` → `createAppContext` (with DB) → CLI handler → resource service →
YNAB client → verification → journal → output

Transaction mutations use `TransactionService`. Month-category assignment uses
`CategoryBudgetService`, requires an explicit category id and exact `YYYY-MM-01` month, and writes
an absolute assigned total rather than a delta. It lists budget months before applying so a change
cannot silently make the future-most Ready to Assign negative. After an ambiguous write error it
reads the category back; confirmed writes still return as applied so the handler journals them.

### Auth commands
`yargs` → handler → config/auth helpers (no `appContext`)

### Local-only commands
- `history list/show` uses the SQLite journal (no YNAB client).
- `budget current` reads the effective budget id (no YNAB client).
- `budget set-default` writes the default budget id to config (no YNAB client).

### History reverts
- `history revert` reads the SQLite journal and dispatches typed inverse patches via the YNAB API.
- Month-category reverts require that the current assigned amount still equals the original
  action's forward value.

## Auth and budget precedence

### Budget id resolution (highest → lowest)
1) CLI `--budget-id`
2) `NAB_BUDGET_ID` env var
3) config `budgetId`

### Auth method resolution (highest → lowest)
1) CLI `--auth`
2) `NAB_AUTH_METHOD` env var
3) env tokens present → PAT
4) config `authMethod`
5) heuristic: OAuth token in config → OAuth, else config tokens → PAT

### Token sources
- PAT: `NAB_TOKENS` env or config `tokens`.
- OAuth: config `oauth.token` (access/refresh tokens), plus client id/secret from env or config.

## OAuth refresh behavior (auto)

- Refresh runs inside `createAppContext` when `requireToken` is `true` and the access token expires within 60s.
- Refresh requires client id/secret + refresh token (env/config).
- Refreshed token is persisted to config; if refresh fails, the config is reloaded to pick up a newer token from another process.
- Commands that do not require a token (e.g., `budget current`, `history`) will not trigger refresh.

## Tricky details / gotchas

- `budget list` still needs a token because it calls the YNAB API.
- Read-only commands usually skip the DB even though they still create `appContext`; transaction
  reads that expose refs open the DB to mint/refresh them.
- YNAB calls the category assigned field `budgeted`; the CLI intentionally uses the current product
  term `assigned`.
- The current API calls a target's date `goal_target_date`; the domain falls back to the deprecated
  `goal_target_month` only for older responses.
- `budget status --month current` returns the exact resolved API month in every output.
- `review transactions` requires `--since-date`; it never invents a hidden review window.
- `auth token check` calls the YNAB API directly (fetch), not via `YnabClient`.
- Transaction mutation commands call `TransactionService`; category assignment and category
  history reverts call `CategoryBudgetService`. Read-only commands access `ctx.ynab` directly.

## Where to start reading (fast mental model)

1) `src/cli/root.ts` (CLI setup + logging middleware)
2) `src/cli/command.ts` + `src/cli/options.ts` (requirements + shared options)
3) `src/app/createAppContext.ts` (auth/budget resolution + OAuth refresh)
4) `src/cli/commands/**` (handlers)
4) `src/api/YnabClient.ts` + `src/api/SingleTokenYnabClient.ts` (API behavior)
5) `src/domain/transactionReview.ts` + `src/domain/budgetHealth.ts` (attention queues)
6) `src/domain/TransactionService.ts` + `src/domain/CategoryBudgetService.ts` +
   `src/journal/**` (mutations + journal)

## Error & exit-code policy

See `docs/CLI_CONVENTIONS.md`.
