---
name: nab-cli-basics
description: Basics for using the nab CLI (YNAB tool). Use when asked how to run nab commands, set up authentication tokens/PATs, configure or override the default budget id, or troubleshoot missing NAB_TOKENS/NAB_BUDGET_ID.
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

## Set auth token (required)
- Use YNAB Personal Access Tokens only (no OAuth).
- Get a PAT from https://app.ynab.com/settings/developer.
- Store tokens with `bunx @jameskraus/nab auth token add <PAT>`.

## Set budget id (required for most commands)
- Run `bunx @jameskraus/nab budget list --format json` and copy the `id` field.
- Store a default budget id with `bunx @jameskraus/nab budget set-default --id <BUDGET_ID>`.
- Override per command with `--budget-id <BUDGET_ID>`.
- Show the effective budget id with `bunx @jameskraus/nab budget current`.

## Notes
- Use date-only strings (`YYYY-MM-DD`).
- Use `--dry-run` to preview mutations and `--yes` to apply them.
