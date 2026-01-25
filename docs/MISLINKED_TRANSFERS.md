# Mislinked Transfers

This document explains why the mislinked-transfer feature exists, how detection works, and what we learned about YNAB API behavior while fixing real cases.

---

## Overview

YNAB sometimes auto-links an imported credit-card payment to the **wrong** cash account. When that happens, YNAB creates a transfer pair that looks valid in the UI but does not match real bank activity. Example (anonymized):

```
Wrong:
  Bob Checking    --(-$35.23)-->  Alice Credit Card
    (phantom)                     (real)

Right:
  Alice Checking  --(-$35.23)-->  Alice Credit Card
    (real)                        (real)
```

- A **real** imported payment exists on the credit card (cleared).
- YNAB creates a **phantom** transfer on a different checking/savings account (not imported, uncleared).
- The **real** cash outflow exists in another account as an **orphan** (imported + cleared, not linked as a transfer).

This feature detects those cases and provides a safe fix workflow.

---

## Terminology

- **Anchor**: The imported + cleared transaction in the transfer pair. This is the "real" side that YNAB matched.
- **Phantom**: The unimported + uncleared transaction in the transfer pair. This is the "fake" side YNAB created.
- **Orphan candidate**: A separate imported + cleared transaction (not a transfer) that appears to be the real match for the phantom.

---

## Detection (review command)

Command:

```
nab review mislinked-transfers [--since-date YYYY-MM-DD] [--import-lag-days N]
```

### Scope

- Only evaluates **checking/savings <-> creditCard** transfer pairs.
- Excludes `cash` and `otherAsset` accounts.
- Requires **direct import linked** on all involved accounts.
- Ignores deleted transactions and deleted accounts.

### Required signals

We only surface a match when **all** of the following are true:

1) **Linked transfer pair exists** between a checking/savings account and a credit card account.
2) **Import mismatch**:
   - Anchor has `import_id`
   - Phantom has no `import_id`
3) **Cleared mismatch**:
   - Anchor is `cleared`
   - Phantom is `uncleared`
4) **Orphan candidate exists** (required):
   - Not a transfer (`transfer_account_id` is null)
   - Imported + cleared
   - Same signed amount as the phantom (exact milliunits match)
   - Date within +/- `--import-lag-days` (default 5)
   - Account type matches the phantom side (checking/savings vs credit)
   - Account is **different** from the phantom's account

If zero orphans match, we **do not** surface the transfer.

### Why we avoid text heuristics

We intentionally do not rely on payee names or account name prefixes (e.g., "B vs A"). This must work without natural language understanding.

---

## Output

Table output prints a summary line:

- Green: `No mislinked-transfers found`
- Orange: a warning plus a suggested fix command

JSON output is stable and includes only anchor/phantom/orphans (no "side" labels):

```json
[
  {
    "anchor": { "id": "...", "account_id": "...", "date": "...", "amount_milliunits": 76190, "import_id": "...", "cleared": "cleared" },
    "phantom": { "id": "...", "account_id": "...", "date": "...", "amount_milliunits": -76190, "import_id": null, "cleared": "uncleared" },
    "orphan_candidates": [
      { "id": "...", "account_id": "...", "date": "...", "amount_milliunits": -76190, "import_id": "...", "cleared": "cleared" }
    ]
  }
]
```

---

## Fixing mislinked transfers

Command:

```
nab fix mislinked-transfer --anchor <id|ref> --phantom <id|ref> --orphan <id|ref>
```

### Validations

Before making changes, the command validates:

- Anchor + phantom are a linked transfer pair.
- Anchor is imported + cleared; phantom is not imported + uncleared.
- Orphan is not a transfer, is imported + cleared, and matches amount/date window.
- All accounts are direct-import linked and not in error.
- Anchor, phantom, orphan, and all involved accounts are not deleted.
- Orphan account type matches phantom account type.

### Confirmed YNAB API behavior (real budget test)

We tested this flow against real mislinked-transfer cases (details anonymized):

**What did NOT work**
- Updating the **anchor** payee to point at the orphan account caused the anchor to disappear.
- After deleting the phantom, only the orphan remained as a normal transaction (no transfer pair).

**What DID work (repeatable)**
1) Update the **orphan** payee to the **anchor account's transfer payee id**.
   - This converts the imported orphan into a transfer.
   - YNAB **auto-creates the other side** of the transfer in the anchor account.
2) Delete the **phantom** transaction.

This flow produced correct transfer pairs in both cases.

### Why this works

In YNAB's API, a transfer is represented by setting `payee_id` to the special "transfer payee" for the destination account. When we set the **orphan's** payee to the anchor account's transfer payee:

- YNAB treats that orphan as a transfer.
- It creates the matching transaction on the anchor side.
- We can then safely delete the phantom side.

---

## Real case summary (from research)

The documented cases involved patterns like:

- Anchor: **Alice Credit Card** payment (imported + cleared)
- Phantom: **Bob Checking** transfer created by YNAB (no import_id + uncleared)
- Orphan: **Alice Checking** real outflow (imported + cleared, not linked)

Example amounts were around **$35.23** and **$1,231.42** (values anonymized).

They were detected via the algorithm above and fixed by updating the orphan payee to the anchor transfer payee, then deleting the phantom.

---

## Limitations

- Only covers checking/savings <-> creditCard transfers (excludes `cash`, `otherAsset`).
- Requires direct-import linked accounts.
- Does not attempt natural language analysis.
- Orphan matching is amount/date based; ambiguous matches are surfaced as multiple candidates.
- Split transfers and transfer moves remain out of scope beyond this targeted fix.
