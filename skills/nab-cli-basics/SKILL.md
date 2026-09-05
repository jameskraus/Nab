---
name: nab-cli-basics
description: Use the nab CLI to review YNAB transactions and budget health, apply per-transaction category/memo/approval batches, safely assign category money, configure PAT/OAuth and budget IDs, or troubleshoot authentication.
---

# Nab CLI Basics

## Overview
Use this guide to explain the minimal setup (auth token + budget id) and common commands for the nab CLI.

## Quick start
- Requires Bun (https://bun.sh).
- Run `bunx @jameskraus/nab --help` to list commands and global options.
- Follow the pattern `bunx @jameskraus/nab <resource> <action> [options]`.
- Use `--format table|json|tsv|ids` to change output format.
- Run common read commands:
  - `bunx @jameskraus/nab budget list`
  - `bunx @jameskraus/nab account list`
  - `bunx @jameskraus/nab category list`
  - `bunx @jameskraus/nab payee list`
  - `bunx @jameskraus/nab tx list`
  - `bunx @jameskraus/nab tx get --id <TRANSACTION_ID>`
  - `bunx @jameskraus/nab review transactions --since-date YYYY-MM-DD --limit 5 --format json`
  - `bunx @jameskraus/nab budget status --month current --format json`

## Set authentication (required)
- Use a YNAB Personal Access Token or OAuth Authorization Code Grant.
- Get a PAT from https://app.ynab.com/settings/developer.
- Store tokens with `bunx @jameskraus/nab auth token add <PAT>`.
- Run `bunx @jameskraus/nab auth oauth --help` for OAuth setup.

## Apply a reviewed transaction batch
- Prefer `nab tx apply --file changes.json --yes --format json` when applying authorized category,
  memo, or approval edits together. Use the maintained checkout's `dist/nab` when available;
  `tx apply --help` confirms command availability.
- The file is `{ "transactions": [{ "id": "<TRANSACTION_UUID>", "category_name": "Groceries",
  "memo": "Weekly shop", "approved": true }] }`. Include only the authorized fields for each row;
  different rows may have different edits. Use exact UUIDs, not short refs or filter selections.
- Category ID and name are mutually exclusive. Category names must resolve unambiguously.
  `memo: null` or `memo: ""` clears the memo; otherwise preserve useful existing notes when replacing
  it. Memos are limited to 500 characters. `approved: false` explicitly unapproves.
- Preview with the same file and `--dry-run`. Categorization does not implicitly approve in the
  CLI; include `approved: true` when the user's instructions authorize both.
- Handle transfers separately with explicit authorization. Batch edits reject transfers and
  splits. Budget assignments still use the separate guarded workflow below.
- Use each returned `transaction` to summarize the saved state; do not immediately fetch those
  same IDs again after successful results. Amounts in these objects are raw milliunits.
- If any row is `unverified`, inspect the per-ID output and history before retrying. The CLI has
  already attempted readback and never replays an uncertain write automatically. Only confirmed
  rows get automatic inverse patches; unverified rows are recorded separately for inspection.

## Set budget id (required for most commands)
- Run `bunx @jameskraus/nab budget list --format json` and copy the `id` field.
- Store a default budget id with `bunx @jameskraus/nab budget set-default --id <BUDGET_ID>`.
- Override per command with `--budget-id <BUDGET_ID>`.
- Show the effective budget id with `bunx @jameskraus/nab budget current`.

## Notes
- Use date-only strings (`YYYY-MM-DD`).
- Use `--dry-run` to preview mutations and `--yes` to apply them.
- Transaction review requires an explicit `--since-date`, unions unapproved and uncategorized
  results, and keeps transfers/splits marked for safe handling.
- `budget status` reports overspending and native target shortfalls. Zero assigned is not an issue
  unless YNAB also reports a target shortfall.
- Category assignment is an absolute operation:
  `bunx @jameskraus/nab category set-assigned --id <CATEGORY_ID> --month YYYY-MM-01 --amount <TOTAL> --dry-run`.
- Applying an assignment requires the exact category id, exact month, `--expected-current`, and
  `--yes` in non-interactive sessions.
- Review the dry-run's `ready_to_assign_guard_month`; nab protects the future-most YNAB month, not
  only the month being edited.
