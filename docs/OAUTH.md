# OAuth Authorization Plan

This document defines the planned OAuth (Authorization Code Grant) flow for `nab`
alongside the existing Personal Access Token (PAT) workflow.

## Goals

- Support YNAB OAuth in addition to PATs.
- Use a localhost redirect handler to complete the Authorization Code Grant flow.
- Store tokens locally and refresh when needed.
- Keep the implementation lean and Bun/yargs-native.

## UX Overview

### Primary commands

- `nab auth oauth init`
  - Guided setup wizard that:
    - Shows the required redirect URI
    - Prompts for client id + client secret
    - Stores settings in config

- `nab auth oauth configure`
  - Stores client settings (client id, optional secret, scope).
  - Flags (proposed):
    - `--client-id <id>` (required unless already configured)
    - `--redirect-uri <uri>` (default `http://127.0.0.1:53682/oauth/callback`)
    - `--client-secret <secret>` (optional; discouraged for shell history)
    - `--prompt-secret` (interactive, no-echo)
    - `--store-secret` (explicit opt-in to persist secret)
    - `--scope read-only|full` (default `full`)
  - Env overrides for non-interactive use:
    - `NAB_OAUTH_CLIENT_ID`
    - `NAB_OAUTH_CLIENT_SECRET`
    - `NAB_OAUTH_SCOPE`

- `nab auth oauth login`
  - Runs the full Authorization Code Grant flow (requires configured client id/secret):
    1) Start loopback server
    2) Open or print authorization URL
    3) Receive authorization code via redirect
    4) Exchange code for tokens
    5) Store tokens in config
    6) Shut down server
  - Flags (proposed):
    - `--open/--no-open` (default: attempt open when TTY, always print URL)
    - `--timeout <seconds>` (default 180)
    - `--scope read-only|full` (default config value, else `full`)
    - `--set-default-auth` (default true; sets auth method preference)

- `nab auth oauth status`
  - Shows redacted OAuth state (logged in, expiry, scope, auth preference).

- `nab auth oauth refresh`
  - Forces a refresh token flow.

- `nab auth oauth logout`
  - Clears stored OAuth tokens (keeps client settings unless `--all`).

- `nab auth use <oauth|pat>`
  - Sets a default auth preference in config.

PAT commands remain unchanged (`nab auth token add/list/check/remove`).

YNAB Developer Settings: https://app.ynab.com/settings/developer

## OAuth Endpoints (YNAB)

Authorization URL (open in browser):
```text
GET https://app.ynab.com/oauth/authorize
  ?client_id=...
  &redirect_uri=...
  &response_type=code
  [&scope=read-only]
  [&state=...]
```

Token exchange:
```text
POST https://app.ynab.com/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=...
client_secret=...
redirect_uri=...
grant_type=authorization_code
code=...
```

Token refresh:
```text
POST https://app.ynab.com/oauth/token
Content-Type: application/x-www-form-urlencoded

client_id=...
client_secret=...
grant_type=refresh_token
refresh_token=...
```

Responses include `access_token`, `refresh_token`, `token_type`, and `expires_in`.

## Config Shape (planned)

Keep PATs at top-level, add OAuth fields and auth preference:

- `tokens: string[]` (PATs, existing)
- `oauth`:
  - `clientId?: string`
  - `clientSecret?: string` (optional; only if `--store-secret`)
  - `redirectUri?: string`
  - `scope?: "full" | "read-only"`
  - `token?: { accessToken, refreshToken, tokenType?, expiresAt }`
- `authMethod?: "pat" | "oauth"`

Config precedence remains:
1) CLI flags
2) Env vars
3) Config file

## Local Redirect Server

- Implement with `Bun.serve` and bind to loopback only (`127.0.0.1`).
- Use a fixed, documented redirect URI by default (YNAB requires exact match).
- Parse the redirect `code` and `state`.
- Respond with a small HTML success page and immediately shut down.
- Enforce timeout (default 180s) and error on missing/mismatched state.

## Security + UX Notes

- Use a cryptographically strong `state` and verify it.
- No PKCE unless YNAB documents support for it (currently not required).
- Never print access/refresh tokens in CLI output.
- Redact secrets in all outputs (`config show`, `oauth status`).
- Lock down config file permissions (best-effort `chmod 600`, dir `chmod 700`).
- Refresh tokens rotate; always store the new refresh token.
- Avoid concurrent refresh races:
  - Refresh only when needed (expired/near expiry).
  - If refresh fails, reload config and retry if another process updated token.
- Scope behavior:
  - Default to `full` (mutations supported).
  - If `read-only`, mutation commands should surface a clear error.

## AppContext Integration Plan

- Add global auth selection resolution:
  - CLI `--auth oauth|pat` (new global flag)
  - `NAB_AUTH_METHOD`
  - `config.authMethod`
  - Heuristic: prefer OAuth if configured, else PAT
- When OAuth is active:
  - If no access token, prompt to run `nab auth oauth login`
  - If expired/near expiry, refresh before creating `YnabClient`
  - Use `[accessToken]` to instantiate `YnabClient` (same API as PATs)
- When PAT is active:
  - Existing logic unchanged

## Implementation Checklist

1) Extend config schema + redaction:
   - add `oauth` fields + `authMethod`
   - redact OAuth tokens/secret
2) OAuth primitives:
   - `buildAuthorizeUrl`
   - `exchangeCodeForToken`
   - `refreshToken`
3) Loopback server:
   - start server, wait for callback, enforce state + timeout, shutdown
4) CLI commands:
   - `auth oauth init/configure/login/status/refresh/logout`
   - `auth use <oauth|pat>`
5) AppContext integration:
   - resolve auth method
   - refresh when needed
6) Error messages:
   - mention OAuth in missing-auth guidance
7) Docs:
   - keep this file updated as the design changes

## Test Plan (lean, high value)

Unit tests:
- `auth/ynabOAuth`:
  - authorize URL includes required params + optional scope/state
  - token exchange uses form-encoded body
  - refresh handles token rotation
- `auth/loopbackServer`:
  - resolves with correct code/state
  - rejects on missing code, state mismatch, or timeout
  - server shuts down after success

AppContext tests:
- OAuth preferred + token expired -> refresh + save + create client
- PAT env present -> PAT path wins
- Missing all auth -> error message mentions OAuth login

CLI smoke tests:
- `nab auth oauth status --format json` redacts secrets
- `nab auth use oauth` updates config
