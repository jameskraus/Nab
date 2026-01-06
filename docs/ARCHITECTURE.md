# Architecture

`nab` is a layered CLI application.

## Naming conventions (rename to `nab`)

- **Binary name:** `nab`
- **Config dir name:** `nab` (OS-specific base path; e.g., `~/.config/nab` on Linux)
- **Env vars (primary):** `NAB_TOKENS`, `NAB_BUDGET_ID`, `NAB_CONFIG_DIR`
- **Migrations:** `schema_migrations` + `schema_version` track journal schema; we only support the latest layout.

## Layers

### 1) CLI / command layer (`src/cli/**`)
Responsibilities:
- parse args (yargs)
- route to command handlers
- validate flags (shape, mutual exclusivity)
- print results (via IO/formatting layer)
- map errors to exit codes

Rules:
- **no YNAB API calls** directly from CLI handlers
- **no SQL** directly from CLI handlers

### 2) Domain / service layer (`src/domain/**`)
Responsibilities:
- implement high-level operations we actually want (approve, categorize, memo set/clear, cleared set, etc.)
- enforce invariants and safety checks (e.g. block transfers for `account set`)
- implement idempotency (no-op when already in desired state)
- produce journal entries (for history) and inverse patches

### 3) API client layer (`src/api/**`)
Responsibilities:
- thin wrapper over YNAB API / SDK
- normalization: milliunits <-> decimal, date parsing/formatting
- consistent error mapping (`401` -> Unauthorized, `404` -> NotFound, `429` -> RateLimited)
- retry/backoff (ONLY where safe)

Implementation notes:
- `YnabClient` wraps the SDK and depends on a small `YnabSdk` adapter interface for testability.
- Rate limit headers are tracked from raw SDK responses.

### 4) Persistence layer
- `src/config/**`: config file (tokens, default budget id)
- `src/journal/**`: sqlite journal of applied actions
- `src/cache/**`: sqlite cache + delta-sync state (`server_knowledge`)

#### Journal DB schema
- `schema_migrations`: applied migration ids with timestamps
- `schema_version`: single-row pointer to the latest migration id
- `history_actions`: journal of applied mutations (payload + inverse patch)
- `cache_entities`: cached API entities keyed by `(budget_id, entity_type, entity_id)`
- `cache_state`: per-budget sync state (`server_knowledge`)

### 5) IO / formatting layer (`src/io/**`)
Responsibilities:
- formatting output in `table|json|tsv|ids`
- locale-friendly date formatting for humans
- machine-friendly JSON for agents

## Composition root

A single composition root should build all services from config:
- config store
- sqlite db
- cache repo
- YNAB client
- domain services

Suggested file: `src/app/createAppContext.ts`.

## Error & exit-code policy

See `docs/CLI_CONVENTIONS.md`.
