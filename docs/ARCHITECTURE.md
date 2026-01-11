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
- attach global middleware (builds `appContext` for most commands)

Notes (current behavior):
- Read-only commands call the YNAB API directly via `ctx.ynab.*` (e.g., `budget list`, `account/category/payee list`, `tx list/get`).
- Mutating commands use the domain service layer for transaction operations.
- `auth` and `config` commands bypass the global middleware and talk to config/auth helpers directly.
- CLI handlers do not execute SQL directly; they call journal helpers in `src/journal/**`.

### 2) App context / composition root (`src/app/createAppContext.ts`)
Responsibilities:
- load config + resolve effective auth method, tokens, and budget id
- optionally open the journal DB
- create the YNAB API client
- handle OAuth token refresh when a token is required (auto-refresh if expiring)

This is the primary “middleware” entrypoint used by commands.

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

## Global middleware behavior (what gets `appContext`)

Global middleware lives in `src/cli/root.ts` and attaches `appContext` for most commands.

Rules (current):
- `auth` and `config`: no middleware (handlers run without `appContext`).
- `history show`: `{ requireToken: false, requireBudgetId: false, createDb: true }`.
- `history revert`: `{ requireToken: true, requireBudgetId: true, createDb: true }`.
- `budget list`: `{ requireToken: true, requireBudgetId: false, createDb: false }`.
- `budget current`: `{ requireToken: false, requireBudgetId: false, createDb: false }`.
- Read-only lists/gets (`account|category|payee list`, `tx list|get`):
  `{ requireToken: true, requireBudgetId: true, createDb: false }`.
- All other commands: `{ requireToken: true, requireBudgetId: true, createDb: true }`.

Why this matters:
- `requireToken` triggers OAuth auto-refresh; commands with it set to `false` will not refresh.
- `createDb` controls journal availability (only mutations and `history` have DB).

## Request flow patterns (current)

### Read-only YNAB commands
`yargs` → middleware → `createAppContext` → CLI handler → `ctx.ynab.*` → output

### Mutation commands
`yargs` → middleware → `createAppContext` (with DB) → CLI handler → `TransactionService` → YNAB client → journal → output

### Auth/config commands
`yargs` → handler → config/auth helpers (no `appContext`)

### Local-only commands
- `history show` uses the SQLite journal (no YNAB client).
- `budget current` reads the effective budget id (no YNAB client).

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
3) config `authMethod`
4) heuristic: env tokens → PAT, else OAuth token in config → OAuth, else config tokens → PAT

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
- Read-only commands skip the DB even though they still create `appContext`.
- `auth token check` calls the YNAB API directly (fetch), not via `YnabClient`.
- Only mutation commands call `TransactionService`; read-only commands access `ctx.ynab` directly.

## Where to start reading (fast mental model)

1) `src/cli/root.ts` (global middleware and command classification)
2) `src/app/createAppContext.ts` (auth/budget resolution + OAuth refresh)
3) `src/cli/commands/**` (handlers)
4) `src/api/YnabClient.ts` + `src/api/SingleTokenYnabClient.ts` (API behavior)
5) `src/domain/TransactionService.ts` + `src/journal/**` (mutations + journal)

## Error & exit-code policy

See `docs/CLI_CONVENTIONS.md`.
