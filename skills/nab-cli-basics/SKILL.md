---
name: nab-cli-basics
description: Basics for using the nab CLI (YNAB tool). Use when asked how to run nab commands, review transactions or budget health, safely assign category money, set up PAT/OAuth authentication, configure the default budget id, or troubleshoot NAB_TOKENS/NAB_BUDGET_ID.
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
