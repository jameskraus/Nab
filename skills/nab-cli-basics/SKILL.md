---
name: nab-cli-basics
description: Basics for using the nab CLI (YNAB tool). Use when asked how to run nab commands, set up authentication tokens/PATs, configure or override the default budget id, or troubleshoot missing NAB_TOKENS/NAB_BUDGET_ID.
---

# Nab CLI Basics

## Overview
Use this guide to explain the minimal setup (auth token + budget id) and common commands for the nab CLI.

## Quick start
- Run `nab --help` to list commands and global options.
- Follow the pattern `nab <resource> <action> [options]`.
- Use `--format table|json|tsv|ids` to change output format.
- Run common read commands:
  - `nab budget list`
  - `nab account list`
  - `nab category list`
  - `nab payee list`
  - `nab tx list`
  - `nab tx get --id <TRANSACTION_ID>`

## Set auth token (required)
- Use YNAB Personal Access Tokens only (no OAuth).
- Get a PAT from https://app.ynab.com/settings/developer.
- Store tokens with `nab auth token add <PAT>`.

## Set budget id (required for most commands)
- Run `nab budget list --format json` and copy the `id` field.
- Store a default budget id with `nab config set --budget-id <BUDGET_ID>`.
- Override per command with `--budget-id <BUDGET_ID>`.

## Useful config helpers
- Run `nab config show` to view config (tokens are redacted).
- Run `nab config path` or `nab config dir` to locate config files.

## Notes
- Use date-only strings (`YYYY-MM-DD`).
- Use `--dry-run` to preview mutations and `--yes` to apply them.
