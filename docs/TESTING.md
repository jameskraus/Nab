# Testing

## Test types

- **Unit tests**: pure functions + repositories with fakes
- **Integration tests**: hit YNAB API against the dedicated safe test budget

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
export YNAC_TOKEN="<PAT>"
export YNAC_BUDGET_ID="06443689-ec9d-45d9-a37a-53dc60014769"

bun test --filter integration
```

Guidelines:
- prefer replayable, idempotent assertions
- avoid changing real data unless the test cleans up after itself
- always include `--dry-run` coverage for mutation commands
