# Testing

## Test types

- **Unit tests**: pure functions + repositories with fakes
- **Integration tests**: hit YNAB API against the dedicated safe test budget
- **E2E tests**: invoke the real CLI end-to-end

## Required integration budget

All integration tests MUST run against:
- Budget ID: `06443689-ec9d-45d9-a37a-53dc60014769`
- Web URL: https://app.ynab.com/06443689-ec9d-45d9-a37a-53dc60014769/budget/202601

## Running unit tests

```bash
bun test
```

## Running integration tests

Integration tests require environment variables:

```bash
export NAB_TOKENS="<PAT1>,<PAT2>"
export NAB_BUDGET_ID="06443689-ec9d-45d9-a37a-53dc60014769"

bun test --filter integration
```

## Running E2E tests

E2E tests execute the real CLI and require:

```bash
export NAB_TOKENS="<PAT1>,<PAT2>"
export NAB_BUDGET_ID="06443689-ec9d-45d9-a37a-53dc60014769"

bun test --filter e2e
```

## Debugging rate limits

To see token rotation/cooldown events while tests run, enable:

```bash
export NAB_TOKEN_TRACE=1
```

Guidelines:
- prefer replayable, idempotent assertions
- test budget mutations are allowed, but always restore original values
- include `--dry-run` coverage where it adds value, not as a hard requirement
