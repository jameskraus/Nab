# Logging

`nab` writes structured NDJSON logs to a local file to support debugging and auditability without polluting stdout/stderr. Each run gets a `runId`, and each command gets a child logger with command metadata.

## Log file location

Default locations:
- macOS: `~/Library/Logs/nab/nab.log`
- Linux: `~/.local/state/nab/nab.log` (or `$XDG_STATE_HOME/nab/nab.log`)
- Windows: `%LOCALAPPDATA%\\nab\\Logs\\nab.log`

Overrides:
- `NAB_LOG_DIR` sets the log directory.
- `NAB_LOG_FILE` sets the filename. If absolute, it is used as-is; if relative, it is joined with `NAB_LOG_DIR` (or the default directory).

## Rotation and retention

On startup, if the active log file exceeds a size threshold it is rotated and a new file is created.

Configuration:
- `NAB_LOG_MAX_BYTES` (default `25000000`)
- `NAB_LOG_RETENTION_DAYS` (default `14`)
- `NAB_LOG_MAX_FILES` (default `30`)

Rotation uses a timestamped filename in the same directory. Cleanup is best-effort (old files are deleted based on max age and max count).

## Log format

Each line is a JSON object. Common fields include:
- `event`: event name (see below)
- `runId`: unique per run
- `timestamp` and `level` (string levels)
- `command`, `subcommand`, `format`, `dryRun`, `yes` for command-scoped logs

## Events

Core lifecycle:
- `run_start`: logged at process start, includes sanitized argv.
- `run_end`: logged on process exit, includes `code` and `durationMs`.
- `command_start`: emitted for each command, includes command metadata.
- `context`: emitted after auth/budget resolution, includes auth method and whether the DB is enabled.
- `cli_fail`: emitted on CLI failures before writing user-facing errors to stderr.

YNAB request tracing (via `YnabClient`):
- `ynab.request`: request lifecycle, includes `name`, `phase` (`start|success|error`), `durationMs`, `status`, plus structured `meta` and `summary` payloads.
- `ynab.token`: token selection/cooldown/disable/skip events, includes a redacted token and reason.

## Redaction and safety

Logs are scrubbed to reduce accidental secret leakage:
- argv is sanitized for token-like strings before logging.
- pino redaction masks common secret paths such as `token`, `accessToken`, `refreshToken`, and `authorization`.
- `YnabClient` emits token traces in a redacted form (`abcd…wxyz`).

## Reading logs

Examples:

```bash
tail -f ~/Library/Logs/nab/nab.log
```

```bash
cat ~/Library/Logs/nab/nab.log | jq 'select(.event=="ynab.request")'
```

```bash
cat ~/Library/Logs/nab/nab.log | jq 'select(.runId=="<run-id>")'
```

## Implementation notes

- Logger initialization happens once in `src/cli/index.ts` via `createRunLogger`.
- `src/cli/root.ts` attaches a command-scoped child logger in middleware.
- `createAppContext` wires token/request trace callbacks to the logger.
