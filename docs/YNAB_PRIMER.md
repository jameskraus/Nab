# YNAB primer (domain + API)

This document gives just enough context about YNAB and the YNAB API to build and maintain `nab`.

## YNAB concepts (domain model)

- **Budget**: a container for everything (accounts, categories, payees, transactions). Most API calls are scoped to a budget id.
- **Account**: where transactions live (Checking, Savings, Credit Card, Cash, etc.).
- **Payee**: who you paid / who paid you.
- **Category**: where spending is categorized (Groceries, Rent, ...). Categories are often nested into category groups.
- **Transaction**: the core object we operate on in v1.
- **Budget month**: one calendar month of income, assigned money, activity, Ready to Assign,
  category balances, and target progress.

## YNAB API basics

- Base URL: `https://api.ynab.com/v1`
- Auth: **Bearer token** (Personal Access Token or OAuth access token)

### Amounts: milliunits

Amounts are represented in **milliunits**:
- `1000` = 1 unit of currency ($1.00)
- `-220` = -$0.22

`nab` accepts user-facing amounts using the **budget currency format** (currently USD-only parsing) and converts to milliunits.
For output, `nab` renders formatted currency strings by default (table/tsv and JSON),
and includes raw milliunit values with a `raw_` prefix alongside display fields (e.g. `amount_display`).

### Dates

YNAB transaction dates are **date-only** values in `YYYY-MM-DD`.

`nab` treats all dates as date-only (no times). When printing dates, we will format them for the user's locale, but preserve the date.

### Cleared status

YNAB models cleared status as one of:
- `cleared`
- `uncleared`
- `reconciled`

### Transfers

Some transactions are transfers between two YNAB accounts; these have transfer metadata (transfer account id, counterpart transaction id).

**V1 scope**: `bunx @jameskraus/nab tx account set` must error on transfers.

### Delta requests

YNAB supports delta requests using `server_knowledge` and `last_knowledge_of_server` to efficiently fetch changes.

### Assigned money and targets

The YNAB API calls a category's assigned amount `budgeted`. `nab` uses the current product term
**assigned** in commands and displays, while sending and receiving `budgeted` milliunits at the API
boundary.

For target health, `goal_under_funded` is the amount still needed in that category for the
requested month. A category with zero assigned can still be healthy because available money rolled
over from a prior month. `nab` therefore does not reconstruct target cadence from `goal_target` and
does not flag zero assigned by itself.

Ready to Assign is the API's `to_be_budgeted` month field. Increasing a category's assigned total
reduces Ready to Assign by the same delta. When money is assigned into future months, the
future-most month has the authoritative Ready to Assign value, so assignment safety must inspect
the months list rather than only the edited month.

Current API responses use `goal_target_date`; `goal_target_month` is deprecated. `nab` preserves
the current field from raw GET responses and uses the older field only as a fallback.

### Rate limiting

The API token is limited to 200 requests/hour (rolling window). Be careful in loops and batch calls.

## Key endpoints we care about (v1)

Read-only:
- List budgets
- List accounts
- List categories
- List payees
- List transactions (budget-wide or account-scoped)
- Get a budget month and its month-specific categories

Transaction list filters (server-side):
- `since_date` (YYYY-MM-DD)
- `type=uncategorized` or `type=unapproved`

Mutations:
- Update a transaction (approve/unapprove, cleared status, category, memo, flag, date, payee, amount, account)
- Delete a transaction
- Set the absolute `budgeted`/assigned amount for one category in one exact month

Target creation/editing, scheduled-transaction funding inference, split editing, and automatic
multi-category funding remain out of scope.

## Full Schema

The full YNAB OpenAPI API schema is available at ./ynab_openapi_spec.yaml for reference. It contains many hints about how endpoints behave and the use of different properties.
