# YNAB Web Sync Test-Budget Validation Plan

Status: planning/audit only; no experiment has been run from this document  
Scope: ordinary YNAB web UI actions in a designated synthetic test budget  
Transport rule: observe browser-generated traffic; do not replay, alter, omit, or manufacture
private requests

This annex defines the smallest practical live-validation run for the unofficial web-sync
specification. Its purpose is to distinguish observed behavior from inference while keeping the
number of server interactions low and preventing writes outside a designated test budget.

It does **not** turn observations into a supported provider contract. Happy-path UI traffic cannot
establish which request fields are required, what invalid inputs do, or what YNAB promises to keep
stable. Those questions require YNAB documentation or written answers.

## Absolute scope boundary

Permitted:

- Open or reload the designated test budget through the normal YNAB web application.
- Observe requests that the unmodified web application generates naturally.
- In an unlinked synthetic account inside that budget, create, modify, and delete a small fixture
  through normal UI controls.
- Passively observe a naturally occurring pending transaction if the test budget already has one.
- Use a documented public-API `GET` only to corroborate public/private ID visibility.

Not permitted by this plan:

- Opening, editing, or navigating into any other budget.
- Calling `/api/v1/catalog` from a console, script, CLI, or copied request.
- Replaying a captured request or changing a header, cookie, cursor, schema version, operation name,
  body, or response.
- Invoking private page methods or sync-manager methods to cause traffic.
- Generating bank activity merely to create a pending transaction.
- Triggering rate limits, authentication failures, cursor failures, conflicts, or Castle challenges.
- Testing private writes outside actions emitted by the unmodified UI.

### Cross-budget limitation

The web application's initialization is account-scoped before it is budget-scoped.
`getInitialUserData`, `syncCatalogData`, and `syncFamilyData` may read account, family, and budget-list
metadata even when the selected budget is the test budget. A profile logged into an account that
contains other budgets therefore cannot guarantee *zero read exposure* to their metadata.

There are only two honest interpretations of "test budget only":

1. **No non-test writes or budget-data sync:** account-level initialization is allowed, but its
   values are neither inspected nor retained. Every `syncBudgetData` target must be the allowlisted
   test budget. This plan can enforce that operationally.
2. **No non-test reads of any kind:** use a separate YNAB test account that contains only the test
   budget. If that is unavailable, live web-protocol validation must stop.

The tester must record which interpretation was approved before opening the app. A dedicated
browser profile reduces accidental exposure but does not change account-level server behavior.

## Evidence labels

Every conclusion produced by the run must carry one of these labels:

- **Observed once:** directly present in one browser-generated request or response.
- **Repeated:** observed in at least two independent natural UI cycles.
- **Relationally supported:** equality, ordering, or transition was observed without recording the
  underlying sensitive values.
- **Inferred:** plausible meaning, not demonstrated as a server contract.
- **Unresolved:** unsafe or impossible to determine under this plan.

The report must never turn "the current client sends this" into "the server requires this."

## Preconditions and proof that the target is the test budget

All preconditions 0–10 are mandatory for every live observation, passive capture, documented public
edge-case comparison, or fixture write in this plan. Static/offline analysis is the only work that
may proceed before precondition 0.

Repository-local policy names the sole candidate integration budget as public ID
`06443689-ec9d-45d9-a37a-53dc60014769` and forbids agents from selecting another budget. That
allowlist satisfies only the candidate-ID part of precondition 1. It does not establish YNAB's
written permission, a current authenticated Chrome session, the visible test name, the private
budget-version join, or the synthetic-account checks. At this report's final check Chrome showed
sign-in and no public test credential was present, so the remaining gates failed and no live request
or UI exercise ran.

0. YNAB has provided written authorization covering the intended private-protocol observation,
   automation/tooling, target test account, request ceiling, retention/redaction method, and any UI
   mutations. User permission alone does not satisfy this provider gate.
1. The user explicitly identifies the test budget by its immutable public budget ID and visible
   name. A name alone is insufficient because names are mutable and non-unique.
2. The run begins at an exact deep link to that budget, not at a recent-budget or last-opened route.
3. The public budget ID, the web application's current budget/user-budget record, and the private
   `budget_version_id` are correlated during bootstrap. Their literal values stay only in process;
   the report stores keyed, run-scoped fingerprints.
4. Immediately before each write, all three checks pass:
   - the exact URL/deep-link identity is still the allowlisted budget;
   - the visible budget name is the expected, unmistakably marked test name;
   - the most recent `syncBudgetData.budget_version_id` fingerprint is the allowlisted fingerprint.
5. Exactly one YNAB application tab is open in the selected browser profile. No other YNAB window,
   installed automation, or mobile collaborator is editing the account during the run.
6. The UI shows all prior changes saved and no edit modal, reconciliation, import review, or undo
   operation in progress.
7. The fixture account is an unlinked, synthetic account in the test budget. Its account, category,
   and payee already exist so transaction creation does not accidentally test several entity types.
8. The fixture account contains no real balances or financial data. If real bank imports or
   unrelated entities appear during the run, stop because cursor deltas are no longer attributable.
9. Browser/app build, browser version, locale, time zone, plan currency, and observed private API
   version are recorded as nonsecret environment metadata.
10. A cleanup operator and a manual UI cleanup procedure are available before the first write.

For stronger assurance, the test account should contain only one budget. With multiple budgets,
the three-way identity check prevents intended UI writes to the wrong budget but cannot prevent the
application's account-level metadata reads.

## Observation and sanitization contract

Do not save a HAR. HAR files commonly contain cookies, session headers, URLs, request bodies, and
full financial responses. The recorder should inspect browser-generated requests in memory and emit
only a schema/delta event such as:

```ts
type SanitizedSyncObservation = {
  runId: string;
  sequence: number;
  trigger: "navigation" | "reload" | "ui-create" | "ui-update" | "ui-delete";
  operationName: string;
  syncType?: string;
  testBudgetMatched?: boolean;
  requestFieldTypes: Record<string, string>;
  requestEntityCounts: Record<string, number>;
  requestEntityFieldSets?: Record<string, string[][]>;
  responseFieldTypes: Record<string, string>;
  responseEntityCounts: Record<string, number>;
  responseEntityFieldSets?: Record<string, string[][]>;
  cursorRelations: string[];
  schemaVersions: Record<string, number>;
  headerPresence: Record<string, boolean>;
  secretRotationRelations: string[];
  responseStatus: number;
  responseMediaType: string;
  responseSizeBucket: "<10KiB" | "10-100KiB" | "100KiB-1MiB" | ">=1MiB";
};
```

Sanitization rules:

- Compare bearer/session/cookie values in memory and emit only equality or rotation booleans. Do
  not write values, hashes, prefixes, lengths, or entropy measurements.
- Represent entity IDs with HMAC-SHA-256 under a random key that exists only for the run. Emit a
  short label such as `tx-A`, not the HMAC, in the final report.
- Record cookie and header **names** only when needed for the wire schema; never values.
- Record field paths, JSON types, nullability, array counts, and enum values. Drop account names,
  payees, memos, balances, transaction amounts, dates, and all user/family/budget identifiers.
- A known synthetic amount may be compared in memory with its encoded integer to report a scale
  relation such as `encoded = displayed major units x 1000`. Do not publish the fixture amount.
- Record dates only as relationships (`selected date preserved`, `one day later`), not literals.
- Do not retain raw `request_data`, `changed_entities`, response bodies, screenshots, console
  output, or browser database files.
- Abort if redaction cannot occur before persistence, logging, exceptions, or agent/model context.

The run ledger contains the intended UI action, the observed request sequence, the fixture's
run-local label, whether cleanup completed, and nothing else.

## Notation for cursor analysis

For sync request `i`:

```text
DS_i = starting_device_knowledge
DE_i = ending_device_knowledge
SS_i = device_knowledge_of_server
SK_i = schema_version_of_knowledge
CE_i = outbound changed_entities
```

For its response:

```text
SC_i = current_server_knowledge
DA_i = server_knowledge_of_device
SR_i = schema_version_of_response
SV_i = schema_version_of_server
RE_i = inbound changed_entities
```

Only relationships are retained:

- whether `DS_i == DE_i` on a no-local-change call;
- whether `DE_i > DS_i` after one UI mutation;
- whether `DA_i == DE_i` after server acknowledgement;
- whether `SS_(i+1) == SC_i` after the response has been applied;
- whether `DS_(i+1) == DE_i` for consecutive local changes;
- whether `SK_(i+1)` derives from `SR_i` or `SV_i`;
- whether `SC_i` is monotonic across the run.

Even a consistent pattern proves only current-client behavior. It does not establish increment
granularity, numeric bounds, rollback rules, or concurrent-device conflict semantics.

## Minimal core validation matrix

The recommended core run makes three small fixture mutations. It should produce roughly one normal
initialization burst plus three normal save operations. Automatic app behavior may vary; use the
hard request budget below.

### V0 — Passive bootstrap and backfill

**Unknowns addressed:** natural operation order; exact request/response key sets and types; header
presence; empty outbound change sets; schema-version relationships; bootstrap/backfill collection
partitioning; token rotation relationships.

**Preconditions:** provider gate plus identity checks 0–10; app closed or quiescent; capture active before navigation;
no other YNAB tab.

**UI action:** open the exact test-budget deep link once and let the ordinary page reach its saved,
idle state. Do not click a sync button or execute page code.

**Expected request observations:** a natural sequence resembling `getInitialUserData`,
`syncCatalogData`, `syncFamilyData`, and `syncBudgetData` bootstrap/backfill; zero outbound budget
entities; initial cursor relationships; the exact `device_info` field tree; request header presence.
Family sync may legitimately be absent.

**Expected response observations:** top-level field trees, collection names/counts, entity field
sets/types, cursor and schema relations, and whether the returned `session_token` is used by the
next naturally generated request. Account/catalog/family values are discarded without inspection.

**Cleanup:** none. Normal session/device acknowledgement metadata may have changed and cannot be
rolled back.

**Stop:** any budget sync targets a non-test fingerprint; any outbound entity is nonempty before a
planned action; challenge/error/retry loop occurs; raw payload reaches disk or logs.

### V1 — Create one ordinary manual transaction

**Unknowns addressed:** normal mutation `sync_type`; outbound device interval; create-entity shape;
money encoding; ID assignment; accepted/cleared/source defaults; server acknowledgement; whether
the response echoes or canonicalizes the new entity.

**Preconditions:** preconditions 0–10 still pass; V0 complete and quiescent; pre-existing synthetic
account/category/payee selected; no new payee creation; request counter below limit.

**UI action:** create one manually entered, uncleared transaction with a small nonzero synthetic
amount and a run-unique memo. Save once through the ordinary transaction editor.

**Expected request delta:** one browser-generated budget-sync mutation containing the new parent in
`be_transaction_groups[].be_transaction` and its complete child closure in
`be_transaction_groups[].be_subtransactions`; a new run-local entity label; `DE > DS`; exact create
field set and types. Responses are expected to flatten these as `be_transactions` and
`be_subtransactions`. Any calculated collections are recorded separately from the user-authored
entity.

**Expected response delta:** device acknowledgement relation, a monotonic or changed server
watermark, and possibly a canonical/echo transaction. Compare the UI amount to the encoded value in
memory to determine scale. A single documented public-API read may check which private identifier,
if any, is public; no private replay is allowed.

**Cleanup:** retain this fixture only until V2 and V3; do not create another.

**Stop:** more than one user-authored transaction appears; an account/payee/category outside the
fixture is changed; the app autosaves an intermediate state not attributable to the single Save;
the budget identity changes.

### V2 — Update exactly one scalar field

**Unknowns addressed:** update identity stability; full-record versus sparse delta behavior; cursor
continuity; enum representation for cleared state; response canonicalization.

**Preconditions:** preconditions 0–10 still pass; V1 acknowledged and UI idle; fixture visible by
its memo; no unrelated deltas.

**UI action:** toggle only the fixture transaction's cleared state from uncleared to cleared and
wait for the normal saved indicator. Do not change amount, date, payee, category, or memo.

**Expected request delta:** the same `tx-A` label in
`be_transaction_groups[].be_transaction`, accompanied by its complete child closure; observation
of the full serialized group; a new device interval; `DS` and `SS` continuity with V1.

**Expected response delta:** server acknowledgement and watermark relations; the cleared enum or
boolean representation; no second transaction.

**Cleanup:** fixture remains for V3. Its temporary cleared state disappears when deleted.

**Stop:** UI generates repeated saves, fixture identity changes unexpectedly, or unrelated entity
IDs appear beyond documented calculations.

### V3 — Delete the fixture

**Unknowns addressed:** tombstone encoding; delete identity; child/canonical response behavior;
cursor acknowledgement; public visibility after deletion.

**Preconditions:** preconditions 0–10 still pass; V2 acknowledged; fixture still uniquely identifiable.

**UI action:** delete the single fixture transaction and confirm through the normal UI once.

**Expected request delta:** `tx-A` appears inside `be_transaction_groups` as a deletion, normally
with `is_tombstone: true`; record whether the tombstone is sparse or full, whether the group carries
children, and whether other collections change. Cursor continuity should be compared with V2.

**Expected response delta:** acknowledgement/watermark relationships and any echoed tombstone. A
documented public read may verify that no active public row remains after normal propagation.

**Cleanup:** this is the visible-state cleanup for V1/V2. Search the test account register for the
run memo and confirm no active row remains.

**Important:** deletion is not byte-for-byte reversal. YNAB may retain a tombstone, audit metadata,
device knowledge, or backups. Report the run as "visible fixture removed," not "server state fully
restored."

**Stop:** delete affects more than `tx-A`, a transfer/split appears unexpectedly, or UI verification
cannot establish that the active fixture is gone.

### V4 — Optional same-profile persistence check

**Unknowns addressed:** device-ID persistence across a normal restart; durable cursor continuation;
whether bootstrap/backfill repeat; deletion readback.

**Preconditions:** preconditions 0–10 still pass; V3 cleanup is complete; request counter remains
below the ceiling.

**UI action:** only after V3 cleanup, close the sole YNAB tab, reopen the exact test-budget deep link
once in the same browser profile, and wait for idle.

**Expected delta:** current static analysis predicts a fresh UUIDv4 device and zeroed in-memory
knowledge after a full page/library initialization, not a persisted same-device cursor. Compare
that relation in memory, require no outbound fixture entity and no active `tx-A`, and record whether
initialization repeats bootstrap/backfill or uses another sequence. Treat any persistence as a new
observation, not the expected contract.

**Cleanup:** close the tab. Do not log out solely for the experiment because logout has broader
session effects.

**Default:** omit V4 if V1-V3 already provide enough consecutive calls to establish cursor
continuity. It adds another initialization burst.

## Optional focused experiments

These are separate opt-ins, not part of the minimal run. Preconditions 0–10 must still pass. Run at
most one per session, only when its specific schema question blocks the specification, and use a
fresh request budget.

| ID | Ordinary UI fixture | Expected primary deltas | Cleanup | Risk/decision |
| --- | --- | --- | --- | --- |
| O1 | Create one two-line split transaction | One `be_transaction_groups` item containing the parent plus two children; flattened response collections; ID references; integer amount-sum relation; one outbound device interval | Delete parent and verify children are absent/tombstoned | Best way to compare device-counter increment per save versus per entity; low/moderate |
| O2 | Create one transfer between two pre-existing synthetic unlinked accounts | Normally two related transaction entities; observe `transfer_account_id`, `transfer_transaction_id`, and any subtransaction link fields | Delete through UI and verify both registers | Moderate; stop if UI proposes reconciliation or real account |
| O3 | Create one future scheduled transaction | outbound `be_scheduled_transaction_groups` containing its parent and any children; subsequent responses flatten to `be_scheduled_transactions` / `be_scheduled_subtransactions`; recurrence field tree | Delete schedule before its occurrence | Moderate; do not use "enter now" or let date arrive |
| O4 | Change one category's assigned amount, then restore its exact original value | User-authored monthly budget entity plus calculated entity collections; two acknowledged intervals | Restore exact amount and verify UI | Low/moderate but not byte-for-byte reversal; calculated values may fan out |
| O5 | Create and then delete one synthetic category inside a pre-existing test group | `be_subcategories` create/tombstone and calculation/month fanout | Delete category after ensuring no transactions use it | Moderate; ordering/tombstone metadata may persist |
| O6 | Import one synthetic file into an unlinked synthetic account | `raw_import`/`matched_import` or public import entity transitions; import IDs and matching links | Use normal Undo Import if offered, then verify register | Higher and potentially noisy; does **not** validate raw bank pending |
| O7 | Open a second tab in the same profile, no edits | Whether device header/session relation is tab- or profile-stable; how tabs consume shared cursor state | Close second tab | Read-only but may create a second initialization burst/concurrency; usually unnecessary |

Do not live-exercise account mappings, linked-bank setup, payee rename rules, onboarding state,
transaction images, account deletion, or plan settings merely to fill schema tables. Their cleanup
and retention behavior is uncertain, and none is required to understand pending reads.

## Passive pending lifecycle observation

Raw pending cannot be safely manufactured through the normal YNAB UI. If the allowlisted test
budget already receives a naturally occurring bank-pending item and preconditions 0–10 all pass, a
separate **passive** study may:

1. Open the exact test budget once and record only field names/types, enum/source values, the
   run-local entity label, accepted/cleared relations, and account-reference mapping.
2. Make no edit, match, approval, rejection, or bank transaction.
3. At a later user-chosen time—not by polling—open the test budget once after the bank naturally
   posts the item.
4. Record whether the pending entity is updated, tombstoned, replaced, or linked through
   `matched_transaction_id`, and whether a public transaction exists through one documented read.

If no natural pending exists, report the pending-transition contract as unresolved. File import,
manual entry, and scheduled entry are not substitutes and must not be used to claim behavior for
`Pending`, `raw_pending`, or `matched_pending`.

## Public-API pending edge-case check

Only when preconditions 0–10 all pass, the test plan is positively bound, and a natural pending
record already exists, make at
most these two documented, read-only public calls under the ordinary public rate limit:

1. `GET /plans/{test_plan_id}` once, because the OpenAPI description calls it a full plan export
   while its nested transaction property does not independently state the list-route pending
   exclusion.
2. `GET /plans/{test_plan_id}/transactions` once, using the same relevant date range, as the
   explicitly pending-excluding control.

Compare only in memory whether the run-local pending label has a public representation. Record
counts and equality/absence relations, not IDs, dates, amounts, or text. Call the single-transaction
GET only if an exact public transaction ID was independently established; never try private IDs or
enumerate guesses. Do not call `POST /transactions/import`: it changes import state and is not a
pending query.

This check can establish current behavior for the fixture and public API version. It cannot turn an
undocumented full-export inclusion into a stable contract. If the two responses disagree, stop and
ask YNAB to document the intended boundary before designing around it.

## Entity-collection coverage decisions

| Collection | Safe evidence source under this plan | Live mutation recommendation |
| --- | --- | --- |
| `first_month`, `last_month` | Passive bootstrap and transaction/month calculations | Observe only |
| `be_budget` | Passive bootstrap | Do not alter plan metadata merely to test it |
| `be_accounts` | Passive bootstrap; pre-existing synthetic account reference | Do not create/close/delete unless independently required |
| `be_account_mappings` | Passive bootstrap | Do not link/unlink a bank |
| `be_account_calculations` | V1-V3 computed fanout | Observe only |
| `be_master_categories` | Passive bootstrap | Optional group fixture only if schema blocks work |
| `be_subcategories` | Passive bootstrap; O5 | O5 optional |
| `be_payees` | Passive bootstrap; pre-existing synthetic payee | Avoid creating/merging/deleting payees in core run |
| `be_payee_rename_conditions` | Passive bootstrap | Do not alter rules |
| `be_settings` | Passive bootstrap | Do not toggle merely for discovery |
| `be_onboarding_events`, `be_onboarding_targets` | Passive bootstrap/static client analysis | Do not exercise |
| `be_expected_income` | Passive bootstrap/static client analysis | Do not exercise without a known reversible UI path |
| monthly budget/calculation collections | Passive bootstrap; O4 | O4 optional |
| `be_scheduled_transactions`, `be_scheduled_subtransactions` | Passive bootstrap; O3 | O3 optional |
| `be_transactions` | V1-V3 and passive pending | Core validation |
| `be_subtransactions` | Passive bootstrap; O1 | O1 optional |
| `be_transaction_images` | Passive bootstrap/static analysis | Do not upload; deletion/retention uncertain |

A "complete" protocol document should list the field schema and confidence for every collection,
but it should not create every entity in a production service merely to improve confidence. Static
client-library analysis and provider confirmation are the appropriate sources for low-value or
irreversible collections.

## Load budget

- One initial natural page load for V0.
- Three intentional mutation saves total for V1-V3.
- At most one optional normal reload for V4.
- No polling and no manual sync-button clicking.
- Only one in-flight UI action; wait for the ordinary saved/idle state before proceeding.
- Hard stop at 20 catalog requests for the whole core run, including initialization, or at two
  unexpected repetitions of the same failed operation.
- Immediate stop on HTTP 401, 403, 409, 429, or 5xx; `Retry-After`; CAPTCHA/challenge; application
  error banner; or any retry loop. Do not attempt to discover thresholds.

The expected count is approximately the app's normal initialization sequence plus three saves.
The ceiling accommodates benign app variation; it is not a quota to consume.

## Global stop conditions

Close the YNAB tab and perform only necessary manual UI cleanup if any condition occurs:

- Public ID, deep-link identity, visible test name, or private budget-version fingerprint disagrees.
- A `syncBudgetData` call targets anything except the allowlisted test fingerprint.
- Any non-test YNAB tab/window is open or the app changes budgets.
- Outbound `changed_entities` is nonempty before the planned fixture action.
- A request contains fixture-unrelated user-authored entities, suggesting another client or import
  is active.
- The UI is not saved/quiescent, a collaborator is editing, or automatic bank imports make the
  delta ambiguous.
- An unknown operation is triggered by a fixture action and appears capable of mutation. Record
  only its name and stop; do not retry.
- More than one user-authored entity changes where only one was expected, except explicitly known
  calculations, transfer pairs, or split children.
- Redaction fails, a secret or raw body is printed, a HAR begins recording, or capture writes raw
  data to disk.
- Authentication, Castle, CSRF, schema, cursor, rate-limit, network, or server errors occur.
- UI cleanup fails or cannot be verified.
- The test account/budget ceases to be synthetic or includes real financial data in the fixture
  scope.

Do not resume the same run after a safety stop. Preserve only sanitized metadata, manually restore
visible test state, and review before scheduling a fresh run.

## Cleanup and post-run verification

1. Delete fixture objects in reverse dependency order through the normal UI.
2. Wait for the saved/idle indicator after each cleanup action; do not force sync.
3. Search the synthetic account/register for the run marker and verify no active fixture remains.
4. If a documented public read was used, verify the public fixture is absent or deleted according
   to documented behavior.
5. Confirm no non-test budget was opened and every observed budget-data request matched the target
   fingerprint.
6. Destroy the run HMAC key, raw in-memory bodies, token-equality working state, and any temporary
   capture process. Delete any accidental raw capture immediately and record the incident without
   copying its contents.
7. Close the test-budget tab/profile. Do not log out or revoke all sessions solely for cleanup
   unless the user separately requests it.
8. Mark cleanup precisely:
   - `visible-state-restored` when all fixtures are absent/restored;
   - `partial` if anything remains or cannot be verified;
   - never claim `server-state-restored`, because tombstones, cursor acknowledgements, audit data,
     device metadata, and backups may remain.

## What the core run can support

If observations match expectations, the core run can strengthen these statements for the captured
web-app/API versions:

- which natural initialization and mutation operations the web client emits;
- exact happy-path request/response field trees and broad JSON types;
- whether changes are sent as full entities or sparse entities by the current client;
- transaction create/update/tombstone shapes;
- how current client calls relate the four observed knowledge values across a no-op and sequential
  local mutations;
- whether session-token and cookie rotation output is consumed by the next normal request;
- current-client money scaling and selected transaction enums;
- current-client persistence across a same-profile reopen, if V4 runs.

These are behavioral observations, not minimum server requirements or stability guarantees.

## Unknowns that this plan cannot ethically or reliably resolve

The specification must keep the following marked `Unknown` unless YNAB supplies a contract or
explicitly authorizes a safer dedicated test harness:

1. **Required versus incidental authentication material.** The normal client sends its normal
   cookies and headers. Without omission/falsification tests, their individual necessity and
   validation order cannot be known.
2. **Castle generation and renewal.** Do not synthesize, reverse engineer, age, or deliberately
   invalidate anti-abuse tokens.
3. **Failure schemas.** Invalid cookie, session, device, schema, cursor, body, operation, ID, and
   permission behavior would require malformed or unauthorized requests.
4. **Retry/idempotency after ambiguous POST completion.** Simulating a dropped response risks
   duplicate or divergent sync state.
5. **Independent device registration.** A new browser profile may create persistent server-side
   device metadata that the UI cannot delete. A reversible test cannot prove registration,
   collision, reset, reuse, or device limits.
6. **Cross-device conflicts and merge precedence.** Testing concurrent writes intentionally creates
   races and cannot isolate the test budget from account/device metadata.
7. **Per-budget versus per-device cursor storage across several budgets.** Answering it requires
   opening a non-test budget, which is out of scope.
8. **Large-budget backfill, pagination, compaction, and cursor rollover.** A light synthetic budget
   cannot exercise production scale, and manufacturing scale would violate the load constraint.
9. **Rate limits and acceptable polling intervals.** Never probe service limits. YNAB must provide
   them.
10. **Exhaustive operation and entity schemas.** UI reachability is conditional on account features,
    onboarding state, subscription/family configuration, linked providers, locale, and plan type.
11. **Exhaustive pending/import states.** Raw bank pending is externally generated. Manual or file
    imports cannot establish `Pending`, `raw_pending`, `matched_pending`, or their transition rules.
12. **Server-side read-only enforcement.** Empty `changed_entities` is a client safety invariant,
    not an authenticated read-only scope.
13. **Minimum/maximum numeric ranges, date boundaries, Unicode limits, duplicate-ID rules, and
    unknown-field behavior.** Happy-path fixtures do not validate rejection rules.
14. **Logout/revocation completeness and token lifetimes.** Testing expiration may affect every
    browser session and cannot prove server retention semantics.
15. **Cookie domain/path/partition edge cases and browser portability.** One logged-in profile is
    not a cross-browser contract.
16. **Family/role/permission behavior.** A single user's test budget cannot establish owner, member,
    child, archived-plan, or shared-plan authorization matrices.
17. **Data retention and deletion.** UI cleanup cannot prove removal from logs, backups, tombstone
    stores, analytics, or fraud systems.
18. **Future compatibility.** A captured web build is a versioned snapshot, never a durable promise.

Those gaps should appear prominently in any YNAB-facing proposal. A genuinely complete
implementable protocol requires provider answers for authentication, device registration, cursor
semantics, error handling, limits, authorization, versioning, and lifecycle; production-service
experiments cannot safely substitute for that contract.

## Recommended execution order

1. Complete static analysis of the current web bundles and internal client-library call graph.
2. Produce a field-by-field draft with confidence tags and a list of exact unresolved questions.
3. Prove precondition 0 and then all identity/safety preconditions 1–10. No V0, V1–V4, optional,
   passive-pending, or public edge-case run may start before all eleven pass.
4. Run V0 only and update the schema diff.
5. Review that no cross-budget body was inspected or retained.
6. If the core cursor/create/delete questions remain material, run V1-V3 once.
7. Run V4 or one optional experiment only if it closes a named blocker.
8. Prefer asking YNAB over additional live probing whenever an answer concerns requirements,
   invalid inputs, security controls, rate limits, or guarantees.
