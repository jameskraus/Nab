# OAuth (Authorization Code Grant)

`nab` supports YNAB OAuth in addition to Personal Access Tokens (PATs). This document
describes the current OAuth flow and configuration.

## Quick setup

1) Create an OAuth app in YNAB Developer Settings: https://app.ynab.com/settings/developer
2) Run `bunx @jameskraus/nab auth oauth init` to store client credentials and show the redirect URI.
3) Run `bunx @jameskraus/nab auth oauth login` to authenticate and store tokens.

## Redirect URI

`nab` uses a fixed loopback redirect URI:

`http://127.0.0.1:53682/oauth/callback`

This must be registered with your YNAB OAuth app.

## Commands

- `bunx @jameskraus/nab auth oauth init`
  - Interactive wizard (TTY required).
  - Prompts for client id/secret and scope.
  - Saves OAuth config and sets `authMethod` to `oauth`.

- `bunx @jameskraus/nab auth oauth configure`
  - Stores client settings (client id, optional secret, scope).
  - Flags:
    - `--client-id <id>` (required unless already configured)
    - `--client-secret <secret>` (only stored with `--store-secret`)
    - `--prompt-secret` (interactive, no-echo)
    - `--store-secret` (explicit opt-in to persist secret)
    - `--scope read-only|full` (default `full`)
  - Redirect URI is always the fixed loopback URI above.

- `bunx @jameskraus/nab auth oauth login`
  - Runs the Authorization Code flow (requires client id/secret):
    1) Start loopback server
    2) Print authorization URL (and open it when possible)
    3) Receive authorization code via redirect
    4) Exchange code for tokens
    5) Store tokens in config
    6) Shut down server
  - Flags:
    - `--client-id <id>`
    - `--client-secret <secret>`
    - `--scope read-only|full` (default config value, else `full`)
    - `--timeout <seconds>` (default 180)
    - `--open/--no-open` (default: open when TTY)
    - `--set-default-auth` (default true; sets auth method preference)

- `bunx @jameskraus/nab auth oauth status`
  - Shows redacted OAuth state (logged in, expiry, scope, auth preference).

- `bunx @jameskraus/nab auth oauth refresh`
  - Forces a refresh token flow.

- `bunx @jameskraus/nab auth oauth logout`
  - Clears stored OAuth tokens (keeps client settings unless `--all`).

- `bunx @jameskraus/nab auth use <oauth|pat>`
  - Sets a default auth preference in config.

PAT commands remain unchanged (`bunx @jameskraus/nab auth token add/list/check/remove`).

## Environment variables

- `NAB_OAUTH_CLIENT_ID`
- `NAB_OAUTH_CLIENT_SECRET`
- `NAB_OAUTH_SCOPE` (`full` or `read-only`)
- `NAB_AUTH_METHOD` (`pat` or `oauth`)

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

## Config shape

- `tokens: string[]` (PATs)
- `oauth`:
  - `clientId?: string`
  - `clientSecret?: string` (optional; only if `--store-secret`)
  - `redirectUri?: string`
  - `scope?: "full" | "read-only"`
  - `token?: { accessToken, refreshToken, tokenType?, expiresAt }`
- `authMethod?: "pat" | "oauth"`

## Auto-refresh behavior

- When a command requires auth and OAuth is selected, `createAppContext` refreshes tokens
  if the access token expires within ~60 seconds.
- Refresh requires client id/secret + refresh token from env or config.
- The refreshed token is persisted; if refresh fails, `createAppContext` reloads config
  to pick up a newer token from another process when possible.

## Security notes

- Access/refresh tokens are never printed in CLI output.
- Secrets and tokens are redacted in status/config output.
- Config directory/file permissions are locked down best-effort (`0700` dir, `0600` file, non-Windows).
