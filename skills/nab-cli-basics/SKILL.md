---
name: nab-cli-basics
description: Basics for using the nab CLI (YNAB tool). Use when asked how to run nab commands, set up authentication tokens/PATs, configure or override the default budget id, or troubleshoot missing NAB_TOKENS/NAB_BUDGET_ID.
---

# Nab CLI Basics

## Overview
Use this guide to explain the minimal setup (auth token + budget id) and common commands for the nab CLI.

## Quick start
- Run `npx -y @jameskraus/nab --help` to list commands and global options (or `bunx @jameskraus/nab` / `pnpx @jameskraus/nab`).
- Follow the pattern `npx -y @jameskraus/nab <resource> <action> [options]`.
- Use `--format table|json|tsv|ids` to change output format.
- Run common read commands:
  - `npx -y @jameskraus/nab budget list`
  - `npx -y @jameskraus/nab account list`
  - `npx -y @jameskraus/nab category list`
  - `npx -y @jameskraus/nab payee list`
  - `npx -y @jameskraus/nab tx list`
  - `npx -y @jameskraus/nab tx get --id <TRANSACTION_ID>`

## Set auth token (required)
- Use YNAB Personal Access Tokens only (no OAuth).
- Get a PAT from https://app.ynab.com/settings/developer.
- Store tokens with `npx -y @jameskraus/nab auth token add <PAT>`.

## Set budget id (required for most commands)
- Run `npx -y @jameskraus/nab budget list --format json` and copy the `id` field.
- Store a default budget id with `npx -y @jameskraus/nab config set --budget-id <BUDGET_ID>`.
- Override per command with `--budget-id <BUDGET_ID>`.

## Useful config helpers
- Run `npx -y @jameskraus/nab config show` to view config (tokens are redacted).
- Run `npx -y @jameskraus/nab config path` or `npx -y @jameskraus/nab config dir` to locate config files.

## Notes
- Use date-only strings (`YYYY-MM-DD`).
- Use `--dry-run` to preview mutations and `--yes` to apply them.
