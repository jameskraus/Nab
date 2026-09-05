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

Preview with `--dry-run`; apply the same IDs with `--yes`. The preview includes conditional
counterpart clearing changes and the old anchor's removal if a new counterpart replaces it.

### Validations

Before making changes, the command validates:

- Anchor + phantom are a linked transfer pair.
- Anchor is imported + cleared; phantom is not imported + uncleared.
- Orphan is not a transfer, is imported + cleared, and matches amount/date window.
- All accounts are direct-import linked and not in error.
- Anchor, phantom, orphan, and all involved accounts are not deleted.
- Orphan account type matches phantom account type.
- The accounts form a checking/savings and credit-card pair; the orphan's account differs from
  the phantom's account. Anchor and phantom have opposite, nonzero amounts.
- None of the selected transactions is split.

After relinking, the command verifies that the orphan and its counterpart are live, in the intended
accounts, have opposite equal amounts, and link reciprocally by both transaction and account IDs.
The orphan must retain its original account, date, amount, import ID, and clearing state. A changed
or missing counterpart blocks cleanup. If the phantom still links to the old anchor, both original
records and their reciprocal links are checked before deliberately deleting that old pair.

### Confirmed YNAB API behavior (real budget test)

We tested this flow against real mislinked-transfer cases (details anonymized):

**What did NOT work**
- Updating the **anchor** payee to point at the orphan account caused the anchor to disappear.
- After deleting the phantom, only the orphan remained as a normal transaction (no transfer pair).

**What DID work (repeatable)**
1) Update the **orphan** payee to the **anchor account's transfer payee id**.
   - This converts the imported orphan into a transfer.
   - YNAB **auto-creates the other side** of the transfer in the anchor account.
2) If YNAB creates a **new mirror transaction**, copy the old anchor's **cleared** status onto that new mirror.
   - The command requests the exact original clearing state, including `reconciled`, and checks
     the saved response before cleanup. The observed live cases used `cleared`; preservation of
     `reconciled` is also covered by synthetic tests.
   - It does **not** preserve `import_id`; the new mirror is still synthetic rather than imported.
   - The new mirror can use the orphan's date, including a bank-posting lag of several days.
3) Delete the **phantom** transaction. When the original pair still exists, YNAB also deletes
   the original anchor. If YNAB instead reuses the anchor as the valid counterpart, retain it and
   delete only the now-unlinked phantom.
4) Re-read the surviving pair and original IDs. Success includes a `verify-repair` result with
   status `verified`; it requires the phantom to be gone, the old anchor to be gone if replaced,
   and the surviving pair and clearing state to remain correct.

This flow produces correct transfer pairs on the intended accounts while preserving cleared state on the new mirror when possible.

### Saved OpenClaw evidence

A September 5, 2026 audit found ten successful repair invocations between May 3 and August 11.
Follow-up transaction reads were inspected for seven repairs across May 3, July 11 (Eastern), and
August 11. They showed the imported orphan preserved, a cleared synthetic counterpart with reciprocal
links, and the original pair absent. July 11 also included explicit not-found responses for the
original IDs. Repairs occurred in both household-account directions. These are historical production
observations, not new production tests; current development tests use only the designated test budget.

### Partial failure and history

The operation is multiple API calls, not atomic. A failure can leave the orphan relinked even when
cleanup did not run. The command emits completed steps plus the failed step and journals successful
writes, including inverse patches for the orphan payee and counterpart clearing state.

Inspect the orphan, its current counterpart, the original anchor, and the phantom before deciding
on recovery. Do not blindly repeat the command or delete a transaction suggested by an older error
message. Network/authentication errors are not proof that a transaction is absent. The journal is
not a full rollback: deleted original transactions and their import metadata cannot be restored by
the saved payee/clearing inverse patches alone. Repair does not request transaction approval.

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
- Even with the cleared-state carry-over, the newly created mirror transaction is still **synthetic**; `import_id` is not preserved.
- Orphan matching is amount/date based; ambiguous matches are surfaced as multiple candidates.
- Split transfers and transfer moves remain out of scope beyond this targeted fix.
