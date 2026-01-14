According to a document from *(date not provided in the upload)*, your CLI currently keeps stdout clean for piping by writing user-facing errors to **stderr** in the yargs `.fail()` handler, and you already have a request “trace callback” hook in `SingleTokenYnabClient` (`trace?: (event) => void`) that emits `start/success/error` with duration—but `createAppContext` only wires up **token tracing** via `NAB_TOKEN_TRACE` and prints it to stderr, and it does **not** wire request tracing into the app context. The plan below replaces that workflow entirely, writes *everything* into **one file**, and gives you durable request+token traces you can inspect after a bad run.

---

# New plan: single-file `pino` logger + durable request/token tracing

## Goals (what this plan guarantees)

1. **Every YNAB API call via `YnabClient` produces trace logs**: start + success/error + duration, plus request parameters and response summaries (counts). *(Optional: also instrument OAuth + token-check HTTP calls if you want literally every YNAB request.)*
2. **No tracing logs go to stdout/stderr by default**, so JSON piping stays safe (stderr remains only for user-facing errors).
3. **All logs persist locally** in a single NDJSON file (`nab.log`) under the OS-appropriate logs directory.
4. **Lightweight & fast to implement**: add `pino`, add ~2–4 small logging helper files, and wire existing callbacks.
5. **Easy “last few minutes” debugging**: you can `tail` the single file and filter by `runId`.
6. **Secrets stay out of logs**: argv + string fields are redacted using regexes that match YNAB PAT/OAuth token shapes, plus pino redaction for known object paths.

Non-goals: external services, complex transports, multi-file split by category.

---

## 1) Dependency changes

### Add `pino` to dependencies

Your `package.json` currently has only a few deps (`yargs`, `ynab`, etc.). Add `pino`:

* `dependencies.pino = "^<latest>"` (pick the latest compatible major; pino v9 is typical now)
* Run `bun install`

No need for `pino-pretty` unless you want human-formatted local viewing (agents can just `jq`).

---

## 2) Log file strategy: “one giant file” + safe rotation

### Default location (macOS + other OS fallbacks)

* macOS (default): `~/Library/Logs/nab/nab.log`
* Linux: `~/.local/state/nab/nab.log` (or `$XDG_STATE_HOME/nab/nab.log` if set)
* Windows: `%LOCALAPPDATA%\nab\Logs\nab.log`

This matches OS conventions and is easy to find.

### Format

* **NDJSON** (one JSON object per line). pino’s default output is perfect for `jq`.

### Rotation/cleanup (still “one giant file” for active use)

To avoid unbounded growth:

* On startup **only**, if `nab.log` exceeds a configured size, rename it to an archive (timestamped), then start a fresh `nab.log`.
* Keep archives for a limited number of days or files.

This keeps day-to-day debugging as “open one file and search/tail”, while preventing runaway disk usage.

---

## 3) New logging configuration (replacing `NAB_TOKEN_TRACE`)

You said we *don’t need to preserve the existing env var workflow* (the `NAB_TOKEN_TRACE` switch and stderr output). We will remove it completely.

We’ll add a simple logging config surface:

| Env var                  |              Default | Purpose                                           |
| ------------------------ | -------------------: | ------------------------------------------------- |
| `NAB_LOG_DIR`            |   *(platform default)* | Log directory                                  |
| `NAB_LOG_FILE`           |            `nab.log` | File name (absolute allowed)                      |
| `NAB_LOG_LEVEL`          |              `debug` | What gets written (debug includes request traces) |
| `NAB_LOG_MAX_BYTES`      |           `25000000` | Rotate if active file bigger than this            |
| `NAB_LOG_RETENTION_DAYS` |                 `14` | Delete rotated logs older than this               |
| `NAB_LOG_MAX_FILES`      |                 `30` | Keep at most N rotated files                      |

**Important default choices:**

* `NAB_LOG_LEVEL=debug` so request start/success logs (which we’ll log at `debug`) are always captured.
* No stderr/stdout logging by default.
* Logging is always enabled; there is no disable switch.

Optional (off by default): `NAB_LOG_TO_STDERR=1` could duplicate `info+` logs to stderr for interactive debugging, but don’t implement this unless you really want it—your requirement is “no logs on stdout/stderr during normal operation”.

---

## 4) Add a small logging module (new files)

Create `src/logging/` with these files:

### 4.1 `src/logging/sanitize.ts`

Purpose: avoid leaking secrets when logging argv or arbitrary strings.

Implement **regex-based redaction** for the *actual* YNAB token shapes (PAT + OAuth access/refresh), regardless of whether they appear as positional args or flag values.

#### Token shape regexes (derive from real tokens)

The regexes below should be **based on the real PAT + OAuth token shapes you already have** (PATs from `nab auth token add`, OAuth tokens from `nab auth oauth login`). Use those values to confirm **length + alphabet**, then encode regexes accordingly. Do **not** log or commit the real tokens—just use them locally to confirm shape.

* **PAT token shape** (expected from YNAB dev tokens): **64 hex chars**.
  * Regex: `/\b[0-9a-f]{64}\b/gi`
* **OAuth access/refresh token shape** (expected from YNAB OAuth): **base64url** (letters, digits, `_`, `-`) **of a fixed length**.
  * Regex (adjust length to observed): `/\b[A-Za-z0-9_-]{64}\b/g`

If your observed OAuth token length differs, update the `{64}` to match (or use a tight range if multiple lengths exist). If PATs are not hex in your environment, change the PAT regex to match the observed alphabet. Keep the regexes **tight** to avoid redacting UUIDs or other non-secret identifiers.

#### `sanitizeArgvForLogs(argv: string[]): string[]`

* For each argv element, apply both token regexes and replace matches with `"[REDACTED]"`.
* This automatically covers:
  * `--flag value`
  * `--flag=value`
  * positional tokens (`nab auth token add <PAT>`)

Return a new array with redacted strings.

### 4.2 `src/logging/file.ts`

Purpose: path resolution, mkdir, rotate, cleanup.

Functions:

* `resolveLogDir(env): string`

  * if `NAB_LOG_DIR` set: use it
  * else (platform default):
    * macOS: `path.join(os.homedir(), "Library", "Logs", "nab")`
    * Linux: `path.join(env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "nab")`
    * Windows: `path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "nab", "Logs")`

* `resolveLogPath(env): string`

  * if `NAB_LOG_FILE` is absolute: use it
  * else: `path.join(resolveLogDir(env), env.NAB_LOG_FILE ?? "nab.log")`

* `rotateIfNeeded(logPath, maxBytes)`

  * if `fs.existsSync(logPath)` and `fs.statSync(logPath).size > maxBytes`:

    * rename to `nab.<timestamp>.log` in same dir
    * timestamp should be filesystem-friendly (replace `:` with `-`)

* `cleanupRotatedLogs(dir, baseName, retentionDays, maxFiles)`

  * delete rotated `nab.<timestamp>.log` that are older than retention
  * also enforce max count

### 4.3 `src/logging/createRunLogger.ts`

Purpose: create a pino logger that writes to file and adds `runId` to every log.

Returns:

```ts
export type RunLogger = {
  logger: pino.Logger;
  runId: string;
  logPath: string;
  close: () => void;
};
```

Implementation details:

1. resolve log path + ensure directory exists
2. rotate + cleanup
3. create destination: `pino.destination({ dest: logPath, sync: true })`

   * `sync: true` is important for a CLI that exits quickly
4. create base pino with:

   * `timestamp: pino.stdTimeFunctions.isoTime`
   * `formatters.level` to store string levels (easier with jq)
   * `redact` paths to prevent accidental token leakage:

     * `"*.token"`, `"*.tokens"`, `"*.accessToken"`, `"*.refreshToken"`, `"*.clientSecret"`, `"headers.authorization"` etc.
5. create a child logger with `{ runId }`

Also: log a `run_start` event immediately (using sanitized argv).

---

## 5) Wire logger into CLI lifecycle (prefer `src/cli/index.ts`)

### Why at the entrypoint?

`createCli()` can be called multiple times in tests or embedded contexts. Initializing logging + `process.on(...)` handlers there risks duplicate listeners. Create the run logger **once** in `src/cli/index.ts`, then pass it into `createCli(...)`.

### 5.1 Create run logger in `src/cli/index.ts`

Add:

* `const startMs = Date.now()`
* `const { logger: baseLogger, runId, logPath, close } = createRunLogger({ argv })`

Then register process hooks (once):

* `process.on("exit", (code) => baseLogger.info({ event:"run_end", code, durationMs: Date.now()-startMs }))`
* `process.on("uncaughtException", (err) => { baseLogger.fatal({ event:"uncaught_exception", err }); close(); process.exit(1); })`
* `process.on("unhandledRejection", (reason) => { baseLogger.error({ event:"unhandled_rejection", err: reason }); })`
* (Optional) `SIGINT`/`SIGTERM` handlers to log and exit cleanly.

### 5.2 Add a middleware to attach a command-scoped logger

Before the existing middleware that calls `createAppContext`, add a *sync* middleware:

* Determine `command` and `subcommand` from `argv._` (same pattern you already use)
* Create:

  * `const cmdLogger = baseLogger.child({ command, subcommand, format: argv.format, dryRun: argv["dry-run"] })`
* Attach:

  * `(argv as any).logger = cmdLogger`
* Log:

  * `cmdLogger.info({ event:"command_start" })`

### 5.3 Pass logger into `createAppContext`

In your existing async middleware that currently does:

```ts
(argv as { appContext?: unknown }).appContext = await createAppContext({ ... });
```

Change it to pass the logger:

```ts
const logger = (argv as any).logger ?? baseLogger;
(argv as any).appContext = await createAppContext({
  argv: argv as ...,
  requireToken,
  requireBudgetId,
  createDb,
  logger,
});
```

Note: You currently skip createAppContext for `auth` and `config` commands. Keep that—those commands won’t need YNAB request tracing anyway, but they’ll still get run_start/run_end logs.

### 5.4 Log failures in `.fail()` *to file*

In `.fail((msg, err, y) => { ... })`, before writing to stderr and exiting, add:

* `baseLogger.error({ event:"cli_fail", msg, err })`

Then keep your existing stderr logic unchanged (it’s correctly protecting stdout).

---

## 6) Make `logger` part of the app context (`src/app/createAppContext.ts`)

### 6.1 Add logger to `AppContext` and options

In `createAppContext.ts`, update:

* `AppContext` to include `logger`
* `AppContextOptions` to accept `logger?: Logger`

### 6.2 Remove `NAB_TOKEN_TRACE` behavior completely

Right now you have:

* `parseBool()`
* `tokenTrace = parseBool(env.NAB_TOKEN_TRACE) ? (...) console.error(...) : undefined;`

Delete that entire block. This is the behavior you explicitly don’t want.

### 6.3 Always create tokenTrace and requestTrace sinks using pino

#### Token trace sink

Your `YnabClient` already redacts tokens before emitting tokenTrace events (`redactToken()` and `tokenTrace?.({ token: redactToken(...) })`), so it’s safe to log.

In `createAppContext`:

```ts
const tokenTrace = (event: TokenTraceEvent) => {
  const level =
    event.action === "disable" ? "warn" :
    event.action === "cooldown" ? "warn" :
    "debug";

  logger[level]({
    event: "ynab.token",
    action: event.action,
    reason: event.reason,
    token: event.token, // already redacted by YnabClient
  });
};
```

#### Request trace sink

You’ll wire into `SingleTokenYnabClient`’s `trace` callback, which currently emits `{ name, phase, durationMs, error }` around every call.

We’ll upgrade that event shape (next section), then log:

* `debug` for start/success
* `error` for error

Everything goes to the same file.

### 6.4 Create YnabClient with both callbacks

Today:

```ts
new YnabClient(tokens, undefined, { tokenTrace })
```



Change to:

```ts
new YnabClient(tokens, undefined, { tokenTrace, trace: requestTrace })
```

Why this works: `YnabClientOptions` extends `SingleTokenYnabClientOptions` and passes those options through when constructing each SingleToken client.

### 6.5 Add a lightweight “context” log event

After auth method/tokens/budget are resolved, log:

* auth method
* token count (not tokens)
* budgetId presence
* db presence

This will help you diagnose “wrong budget used” or “missing budget context” issues.

### 6.6 Default to a silent logger when none is provided

`createAppContext` is used directly in unit tests. If no logger is passed, use a no-op logger (or `pino({ level: "silent" })`) so tests don’t create files or require a logging setup.

---

## 7) Upgrade request tracing to include the info you actually need

Right now `RequestTraceEvent` has no status, no params, no response summary. For the “incomplete data on first run” bug, the *most important thing* is: **how many items did we get back** (and what filters were used).

### 7.1 Change `RequestTraceEvent` in `src/api/SingleTokenYnabClient.ts`

Replace the current type with something like:

```ts
export type RequestTraceEvent = {
  requestId: string;
  name: string;
  phase: "start" | "success" | "error";

  startTime?: string; // ISO
  durationMs?: number;

  // request context (safe subset)
  meta?: Record<string, unknown>;

  // response context
  summary?: Record<string, unknown>;

  // error context
  status?: number; // best-effort
  error?: unknown;
};
```

### 7.2 Update `traced()` to generate requestId and include meta/summary

Current code in `traced()` emits start/success/error without requestId or meta.

Update it to:

* generate `requestId` at start
* include `startTime` on start
* include `meta` on start/success/error
* include `summary` on success
* include `status` on error (derived from your mapped error types, best-effort)

Also update the signature to accept meta and a summarizer:

```ts
private async traced<T>(
  name: string,
  fn: () => Promise<T>,
  meta?: Record<string, unknown>,
  summarize?: (result: T) => Record<string, unknown> | undefined,
): Promise<T>
```

### 7.3 Add per-method meta + summary (counts, not content)

Update each YNAB method to pass safe meta and summary. Examples:

* `listTransactions(budgetId, sinceDate?, type?)`

  * meta: `{ budgetId, sinceDate, type }`
  * summary: `{ count: transactions.length }`

* `listAccountTransactions(budgetId, accountId, sinceDate?, type?)`

  * meta: `{ budgetId, accountId, sinceDate, type }`
  * summary: `{ count }`

* `listCategories(budgetId)`

  * meta: `{ budgetId }`
  * summary: `{ groupCount, categoryCount }` (compute category count by summing `group.categories.length`)

* `getTransaction(budgetId, transactionId)`

  * meta: `{ budgetId, transactionId }`
  * summary: `{ found: true }` or `{}`

**Key rule:** Do *not* log full transaction payloads, memos, amounts, etc. Stick to IDs and counts.

This is implementable quickly because all methods already run through `traced(...)` in one place.

### 7.4 (Optional) Add retry visibility

`SingleTokenYnabClient.executeGet` retries on rate limit/network errors. Add a `retry` trace event or include `attempt`/`retryCount` in `meta` so you can see when a successful response required retries.

---

## 8) Map token rotation events into the same log file

`YnabClient` already emits token selection/skip/cooldown/disable events via the `tokenTrace` callback. After you wire `tokenTrace` to pino (in createAppContext), your logs will show sequences like:

* token selected
* request start
* request success (with count)
* etc.

This is exactly what you’ll want when a request returns incomplete data: you’ll know which token was used and how many records came back.

---

## 9) Make sure JSON piping remains safe

You already designed the CLI to keep stdout clean and write errors to stderr only. This plan preserves that:

* pino writes to file only
* no stderr trace output (we delete the `console.error` token tracing)
* stderr remains for user-facing errors only

---

## 10) What the resulting logs look like (single file)

Example lines you should expect in `nab.log`:

```json
{"time":"2026-01-13T22:10:01.123Z","level":"info","app":"nab","version":"0.1.0","pid":12345,"runId":"...","event":"run_start","argv":["tx","list","--format","json"]}
{"time":"2026-01-13T22:10:01.200Z","level":"info","runId":"...","command":"tx","subcommand":"list","event":"command_start"}
{"time":"2026-01-13T22:10:01.450Z","level":"debug","runId":"...","event":"ynab.token","action":"select","token":"abcd…wxyz"}
{"time":"2026-01-13T22:10:01.451Z","level":"debug","runId":"...","event":"ynab.request","phase":"start","name":"listTransactions","requestId":"...","meta":{"budgetId":"...","sinceDate":"2026-01-01"}}
{"time":"2026-01-13T22:10:01.900Z","level":"debug","runId":"...","event":"ynab.request","phase":"success","name":"listTransactions","requestId":"...","durationMs":449,"summary":{"count":13}}
{"time":"2026-01-13T22:10:02.050Z","level":"info","runId":"...","event":"run_end","code":0,"durationMs":927}
```

This is enough to answer: *“what happened in the last run / last few minutes?”* without ever having printed anything during execution.

---

## 11) Exact implementation checklist for an agent

### A) Add dependencies

* [ ] Add `pino` to `package.json` dependencies
* [ ] `bun install`

### B) Add new modules

* [ ] `src/logging/sanitize.ts` (regex redaction for PAT + OAuth token shapes)
* [ ] `src/logging/file.ts`
* [ ] `src/logging/createRunLogger.ts`
* [ ] `src/logging/index.ts` exporting the above

### C) Update CLI entrypoint + root

* [ ] Create run logger in `src/cli/index.ts` and register exit/error hooks once
* [ ] Update `createCli` signature to accept a base logger (and maybe runId/logPath)
* [ ] Add middleware to attach `argv.logger = baseLogger.child({ command, subcommand, ... })`
* [ ] Pass that logger into all `createAppContext({...})` calls (including the history special case)
* [ ] In `.fail`, log to file before existing stderr output

### D) Update app context (`src/app/createAppContext.ts`)

* [ ] Add `logger` to `AppContext` return type and `AppContextOptions`
* [ ] Default to a no-op logger if none is provided (tests)
* [ ] Remove `NAB_TOKEN_TRACE` parsing and stderr logging entirely
* [ ] Always create `tokenTrace` and `requestTrace` functions that log to pino
* [ ] Construct `YnabClient` with `{ tokenTrace, trace: requestTrace }` instead of only tokenTrace

### E) Update API trace events (`src/api/SingleTokenYnabClient.ts`)

* [ ] Expand `RequestTraceEvent` type to include `requestId`, `meta`, `summary`, and best-effort `status`
* [ ] Update `traced()` to emit those fields and accept meta/summarizer
* [ ] Update each API method to pass meta + summary counts (especially list calls)

### F) Quick validation steps

* [ ] Run a command that outputs JSON and pipe it: ensure stdout is only JSON, no extra noise
* [ ] Confirm `~/Library/Logs/nab/nab.log` exists and contains `run_start`, `command_start`, and `ynab.request` events
* [ ] Force an error (e.g., bad budget id) and confirm:

  * stderr shows formatted error (existing behavior)
  * log file includes `cli_fail` and request error events

### G) Docs updates (required)

* [ ] Update `docs/ARCHITECTURE.md` to describe the logging subsystem + env vars
* [ ] Update README or a logging doc with how to find logs + how redaction works

---

If you want, I can also propose a tiny optional follow-up command like `nab logs tail` (prints last N lines to **stderr**) for convenience, but I’ve left it out here since your core requirement is “don’t print logs during normal operation.”
