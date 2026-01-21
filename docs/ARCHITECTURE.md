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
- Mutating commands use the domain service layer for transaction operations.
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

### 4) API client layer (`src/api/**`)
Responsibilities:
- thin wrapper over YNAB API / SDK
- consistent error mapping (`401` -> Unauthorized, `404` -> NotFound, `429` -> RateLimited)
- retry/backoff (ONLY where safe)
- exposes account-scoped transaction listing and server-side transaction type filters

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
- Mutations (`tx *` except list/get/memo get): `{ auth: true, budget: "required", db: true, mutation: true }`.

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
`yargs` → `defineCommand` → `createAppContext` (with DB) → CLI handler → `TransactionService` → YNAB client → journal → output

### Auth commands
`yargs` → handler → config/auth helpers (no `appContext`)

### Local-only commands
- `history list/show` uses the SQLite journal (no YNAB client).
- `budget current` reads the effective budget id (no YNAB client).
- `budget set-default` writes the default budget id to config (no YNAB client).

### History reverts
- `history revert` reads the SQLite journal and applies inverse patches via the YNAB API.

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
- Read-only commands usually skip the DB even though they still create `appContext`; tx list/get and tx memo get open the DB to mint/refresh refs.
- `auth token check` calls the YNAB API directly (fetch), not via `YnabClient`.
- Only mutation commands call `TransactionService`; read-only commands access `ctx.ynab` directly (even when they open the DB for refs).

## Where to start reading (fast mental model)

1) `src/cli/root.ts` (CLI setup + logging middleware)
2) `src/cli/command.ts` + `src/cli/options.ts` (requirements + shared options)
3) `src/app/createAppContext.ts` (auth/budget resolution + OAuth refresh)
4) `src/cli/commands/**` (handlers)
4) `src/api/YnabClient.ts` + `src/api/SingleTokenYnabClient.ts` (API behavior)
5) `src/domain/TransactionService.ts` + `src/journal/**` (mutations + journal)

## Error & exit-code policy

See `docs/CLI_CONVENTIONS.md`.
