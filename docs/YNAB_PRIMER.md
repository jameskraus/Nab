# YNAB primer (domain + API)

This document gives just enough context about YNAB and the YNAB API to build and maintain `ynac`.

## YNAB concepts (domain model)

- **Budget**: a container for everything (accounts, categories, payees, transactions). Most API calls are scoped to a budget id.
- **Account**: where transactions live (Checking, Savings, Credit Card, Cash, etc.).
- **Payee**: who you paid / who paid you.
- **Category**: where spending is categorized (Groceries, Rent, ...). Categories are often nested into category groups.
- **Transaction**: the core object we operate on in v1.

## YNAB API basics

- Base URL: `https://api.ynab.com/v1`
- Auth: **Bearer token** (Personal Access Token is fine for personal usage)

### Amounts: milliunits

Amounts are represented in **milliunits**:
- `1000` = 1 unit of currency ($1.00)
- `-220` = -$0.22

`ynac` will accept user-facing decimal amounts (e.g. `-12.34`) and convert to milliunits.

### Dates

YNAB transaction dates are **date-only** values in `YYYY-MM-DD`.

`ynac` treats all dates as date-only (no times). When printing dates, we will format them for the user's locale, but preserve the date.

### Cleared status

YNAB models cleared status as one of:
- `cleared`
- `uncleared`
- `reconciled`

### Transfers

Some transactions are transfers between two YNAB accounts; these have transfer metadata (transfer account id, counterpart transaction id).

**V1 scope**: `ynac tx account set` must error on transfers.

### Delta requests (important for caching)

YNAB supports delta requests using `server_knowledge` and `last_knowledge_of_server` so we can efficiently sync changes.

### Rate limiting

The API token is limited to 200 requests/hour (rolling window). `ynac` must cache, dedupe, and be careful in loops.

## Key endpoints we care about (v1)

Read-only:
- List budgets
- List accounts
- List categories
- List payees
- List transactions

Mutations (transactions only, v1):
- Update a transaction (approve/unapprove, cleared status, category, memo, flag, date, payee, amount, account)
- Delete a transaction

> Note: We intentionally leave budgets/payees/scheduled transactions out of scope for v1.

