# YNAB Web Client Runtime and Sync Library

Status: reverse-engineered research reference; not an official API contract  
Snapshot: 2026-08-30  
Current schemas: catalog `17`, budget `44`, family `4`  
Current catalog API header: `2026-01-01`

This document describes the client library that the current YNAB web application actually uses to
materialize and synchronize its entity graph. It is the implementation companion to
[YNAB_CATALOG_PROTOCOL.md](./YNAB_CATALOG_PROTOCOL.md). Evidence labels and exact asset hashes are
in [YNAB_PROTOCOL_PROVENANCE.md](./YNAB_PROTOCOL_PROVENANCE.md).

The names below are human-readable names exported or retained by the exact reviewed build. They are
useful build locators, not a stability promise. Minified constructor letters are deliberately
omitted.

## 1. Runtime topology

The page exposes `window.ynab.YNABSharedLib.defaultInstance`. Its current own properties are
`_apiAdapter`, `_changeSetManager`, `_configObj`, `_deviceInfo`, `_displayEntityManager`,
`_entityManager`, `_formattingManager`, `_portationManager`, `_syncManager`,
`_transitionMapManager`, `_viewModelManager`, and `_ynabStore`; public getters expose the logical
manager names used below.

```text
window.ynab
└── YNABSharedLib.defaultInstance
    ├── apiAdapter
    │   ├── v1                 catalog RPC adapter
    │   ├── v2                 newer REST-like application operations
    │   └── onlineApi          application-private token-auth resource layer (not api.ynab.com/v1)
    ├── store                  session, active documents, knowledge state, sync orchestration
    ├── entityManager          identity maps and entity collections
    ├── changeSetManager       local atomic edit, undo, and redo tracking
    ├── syncManager            queue, heartbeat, serialization, and connection state
    ├── displayEntityManager   UI transaction projections
    ├── transitionMapManager   navigation/business transitions
    ├── viewModelManager       catalog and budget projections
    ├── formattingManager      date/currency/percentage formatting
    └── portationManager       CSV/QIF/OFX import and export
```

The shared instance owns one active catalog, at most one active family, and at most one active
budget version. Switching budgets clears every active budget collection and creates a fresh budget
knowledge object.

## 2. API adapter layers

| Layer | Auth mode in current web build | Purpose |
| --- | --- | --- |
| V1 | `useTokenAuth = false` | `/api/v1/catalog` operations plus a few V1 import/account calls |
| V2 | `useTokenAuth = false` | family/group/user and newer application resources |
| Online API | `useTokenAuth = true` | application-private token-authenticated REST-like resources; not the documented public YNAB API |

The V1 catalog adapter has these operation wrappers:

| Client method | `operation_name` | Classification |
| --- | --- | --- |
| `loginUserWithSessionToken` | `getInitialUserData` | session bootstrap/read |
| `login` | `loginUser` | authentication write |
| `logout` | `logoutUser` | session write |
| `syncCatalogDataWithServer` | `syncCatalogData` | bidirectional sync |
| `syncFamilyDataWithServer` | `syncFamilyData` | bidirectional sync, although current family model has no local writes |
| `syncBudgetDataWithServer` | `syncBudgetData` | bidirectional sync |
| `createNewBudget` | `createNewBudget` | write |
| `deleteBudget` | `deleteBudget` | destructive write |
| `freshStartABudget` | `freshStartABudget` | write |
| `stageDirectImportData` | `stageDirectImportData` | write/import |
| `unlinkAccountFromDirectImport` | `unlinkAccount` | write |
| `recordSubscriptionReceiptToServer` | `recordSubscriptionReceipt` | write |
| `initiatePasswordReset` | `initiatePasswordReset` | account workflow |
| `resetPassword` | `resetPassword` | account write |
| `registerNewUser` | `signupUser` | account write |

The `pending-read-v1` profile permits only `getInitialUserData`, `syncCatalogData`,
`syncFamilyData`, and `syncBudgetData`, and permits the three sync operations only with no outbound
knowledge interval and no entity changes.

### 2.1 Read-only guard used by the web library

The current V1 adapter's own guard does not inspect collection values. Its `hasChangedEntities`
test is exactly equivalent to:

```ts
const start = request.starting_device_knowledge ?? 0;
const hasWrites = (request.ending_device_knowledge ?? 0) > start;
```

In read-only mode it always permits login, logout, and initial-user-data operations. It permits a
sync operation only when `hasWrites` is false; otherwise it throws
`WriteRequestWhileReadOnlyError` before transport.

A NAB implementation must be stricter: it must require equality, validate every collection as
empty/absent, and reject unknown fields. The official guard is evidence about cursor meaning, not a
sufficient security boundary.

## 3. Session initialization

The session-token path is:

```text
existing page session token
    │
    ▼
store.loginUserWithSessionToken(token)
    ├── if another user session is active, logout first
    ├── set adapter sessionToken provisionally
    ├── build { device_info: getDeviceInfo() }
    └── operation getInitialUserData
          │
          ▼
baseHandleLoginUserResponse
    ├── require response.session_token and response.user
    ├── replace adapter sessionToken with response.session_token
    ├── retain Castle/help JWTs for browser features
    ├── materialize user entity
    ├── create catalog knowledge at schema 17, all counters zero
    └── syncCatalogAndFamilyDataWithServer
```

`getDeviceInfo()` serializes these keys:

```ts
type DeviceInfo = {
  id: string;
  device_name?: string;
  device_type?: string;
  device_os?: string;
  device_os_version?: string;
  browser_name?: string;
  browser_version?: string;
  ynab_app_version?: string;
};
```

The current web-store initializer generates a new UUIDv4 with `crypto.randomUUID()` (falling back
to cryptographically random UUID construction) and assigns it as the adapter device ID. The current
web store's catalog/family/budget knowledge persistence hooks are no-ops. Consequently, this web
build begins a fresh in-memory device/knowledge session after a full page initialization. This is
strong evidence that a new UUID plus zero knowledge is technically accepted by the current web
flow; it is not provider authorization for a standalone client.

Logout first tries catalog/family sync and budget sync, ignoring their failures, then calls
`logoutUser`, clears user/session state, and clears every collection. A caller must never invoke
logout merely to “test” credentials because it changes server and browser session state.

## 4. Knowledge model

Catalog, family, and budget documents each use an independent knowledge object:

```ts
type Knowledge = {
  currentDeviceKnowledge: number;
  serverKnowledgeOfDevice: number;
  deviceKnowledgeOfServer: number;
  schemaVersionOfKnowledge: number;
  lastDeviceKnowledgeLoadedFromLocalStorage: number;
  lastDeviceKnowledgeSavedToLocalStorage: number;
};
```

Budget knowledge adds `queueCalculationsForServerEntities`.

Define:

- `D = currentDeviceKnowledge`: highest local entity-change sequence assigned by this device.
- `SD = serverKnowledgeOfDevice`: highest device sequence the server says it has accepted.
- `DS = deviceKnowledgeOfServer`: highest server sequence the client has committed locally.
- `SVK = schemaVersionOfKnowledge`: schema under which the stored knowledge was interpreted.

The web library starts all counters at zero. Every attached catalog/budget entity has its own
`deviceKnowledge`. A local property change increments the containing document's `D` and assigns the
new value to that entity. Server-originated creation or merge suppresses knowledge increment and
sets the entity's device knowledge to zero.

Changed local collections are selected with:

```text
entity.deviceKnowledge > SD
```

This means the outgoing interval is `(SD, D]`, represented by
`starting_device_knowledge = SD` and `ending_device_knowledge = D`.

### 4.1 Knowledge invariants in the current client

Before request:

```text
0 <= SD <= D
0 <= DS
SVK is non-null
```

After response, before merge:

1. `schema_version_of_response` must equal the client's current document schema exactly.
2. `schema_version_of_response` must be greater than or equal to `SVK`.
3. Set `SD = response.server_knowledge_of_device`.
4. If `D < SD`, accept the server value only when `D == 0`; set `D = SD`. Otherwise throw because
   the server claims more knowledge of this device than the client has of itself.

After a successful non-bootstrap merge:

```text
SVK = response.schema_version_of_response
DS  = response.current_server_knowledge
```

The current web client does not explicitly reject `current_server_knowledge < DS`; it logs whether
the delta is positive or zero. A clean-room client must reject regression rather than copy that
omission.

## 5. Sync modes and call graph

The current enum is closed and exact:

```ts
type BudgetSyncType = "bootstrap" | "backfill" | "delta";
```

### 5.1 Budget activation

With two-step initial sync enabled, `setActiveBudget` does this:

```text
if a different active budget exists and the library is not read-only:
    delta-sync it before switching
clear active budget collections and knowledge
resolve requested user-budget authorization from catalog
create budget knowledge(schema = 44, counters = 0)
syncBudgetDataWithServer("bootstrap") and await it
set SyncManager backfill flag false
schedule syncBudgetDataBackfill() without awaiting it
materialize active budget and initialize formatters
```

The asynchronous backfill boundary matters. “Budget visible” is not equivalent to “historical
transaction set complete.” A consumer needs an explicit `partial_bootstrap` state until backfill
has committed.

### 5.2 SyncManager serialization

`SyncManager.syncData(catalogAndFamily = true, budget = true)` ORs the requested document flags into
queued flags. If no sync promise exists it creates one. The worker:

1. drains catalog/family first;
2. drains budget second;
3. repeats recursively while another caller has queued either flag;
4. clears the shared promise in a `finally` block.

Only one shared sync worker is active. The store also has independent in-progress flags; a direct
store call made while the same document is in flight returns a result marked
`syncCancelledBecauseAnotherInFlight` instead of issuing another request.

Normal budget work calls `syncBudgetDataWithServer("delta")`. If the manager's backfill flag is set,
it calls `"backfill"`, clears the flag, dispatches a backfill-complete event, and queues a delta when
`currentDeviceKnowledge > 0`. That follow-up uploads client-side transformations produced by
automatic import in normal read/write mode.

### 5.3 Heartbeat

Automatic sync is enabled in the observed page. The shared library's default interval is 60,000 ms;
the current web application overrides it to 180,000 ms. The heartbeat tracks last catalog/family
and budget times separately, syncs either when it is within two seconds of due, and schedules the
next heartbeat for the earlier due document. Hiding the page stops the heartbeat without flushing;
making it visible restarts it with an immediate heartbeat. Connection state is considered
disconnected only for HTTP status `0`, `503`, or timeout; other HTTP errors leave the connection
state “connected” even though the operation failed.

## 6. Store algorithms

### 6.1 Catalog sync

Request construction:

```ts
const request = {
  user_id,
  schema_version: 17,
  schema_version_of_knowledge: SVK,
  starting_device_knowledge: SD,
  ending_device_knowledge: D,
  device_knowledge_of_server: DS,
  changed_entities: {
    ce_users,
    ce_user_budgets,
    ce_user_settings,
    ce_user_privacy_policy_agreements,
  },
};
```

Empty arrays are converted to omitted properties before `JSON.stringify`; the top-level
`changed_entities` object remains.

The store snapshots `D` before waiting for the server. If `D` increased while the request was in
flight, it does not merge the incoming catalog response and does not advance `DS`. The queued sync
worker will run again. Otherwise it merges all catalog collections, updates view models, then
advances `SVK` and `DS`.

After catalog sync it reevaluates the active family from the user record. A user with no family ID
causes family state to be cleared; a new family ID creates fresh family knowledge at schema `4`.

### 6.2 Family sync

Family requests have no `changed_entities` member in the current web client:

```ts
const request = {
  family_id,
  schema_version: 4,
  schema_version_of_knowledge: SVK,
  starting_device_knowledge: SD,
  ending_device_knowledge: D,
  device_knowledge_of_server: DS,
};
```

The same in-flight local-change and knowledge validation rules apply. Current entity management
throws if asked to increment knowledge for a family entity, so this path is effectively server to
client in this build.

### 6.3 Budget sync

For normal `bootstrap` or `delta`:

```text
request.starting_device_knowledge = SD
request.ending_device_knowledge   = D
```

For `backfill`:

```text
request.starting_device_knowledge = 0
request.ending_device_knowledge   = 0
```

Backfill therefore sends no local changes even if the in-memory device has them. The remaining
fields are:

```ts
const request = {
  budget_version_id,
  sync_type,
  starting_device_knowledge,
  ending_device_knowledge,
  device_knowledge_of_server: DS,
  calculated_entities_included: false,
  schema_version: 44,
  schema_version_of_knowledge: SVK,
  changed_entities,
};
```

The store serializes local changes only when the effective ending knowledge is greater than zero.
For a zero-bound request it constructs the full known request collection object with every member
undefined, which `JSON.stringify` reduces to `{}`.

After response validation it snapshots whether `D` changed while waiting. Incoming entities are
ignored only when the mode is `delta` and a concurrent local change occurred. Bootstrap and
backfill still merge.

The handler:

1. parses `first_month` and `last_month` into cached month bounds when both exist;
2. merges every flat response collection;
3. updates loaded budget view models;
4. invokes registered sync callbacks with the union of outgoing and incoming materialized entities;
5. advances `SVK` and `DS` only when the mode is not `bootstrap`.

This explains the two-step algorithm: bootstrap materializes a usable current plan but deliberately
does not checkpoint server knowledge; backfill completes the current client's observed staged load
and materialized history, then supplies the checkpoint. It does not prove provider retention or
unbounded historical completeness.

In normal read/write mode, delta responses containing a `raw_import` or `raw_pending` entity trigger
the automatic import manager. Backfill forces the import manager even without a staged entity in
the response. Bootstrap never triggers automatic import. Library read-only mode also skips it.

## 7. Change-set and outgoing entity construction

The entity manager uses attached editable entities plus detached clones. A change set tracks clones
for editing/creation, validates them, and merges accepted clones back into the attached identity
map. Property changes on attached entities increment document knowledge and support undo/redo.

Catalog outgoing collections are flat. Budget outgoing transaction parents are grouped with their
children:

```ts
type TransactionWriteGroup = {
  id: string;
  be_transaction: TransactionWire;
  be_subtransactions: SubTransactionWire[] | null;
};

type ScheduledTransactionWriteGroup = {
  id: string;
  be_scheduled_transaction: ScheduledTransactionWire;
  be_scheduled_subtransactions: ScheduledSubTransactionWire[] | null;
};
```

The outbound keys are:

```text
be_budget
be_expected_income
be_accounts
be_account_mappings
be_master_categories
be_monthly_budgets
be_monthly_subcategory_budgets
be_payees
be_payee_locations
be_payee_rename_conditions
be_scheduled_transaction_groups
be_settings
be_subcategories
be_transaction_groups
be_money_movements
be_money_movement_groups
be_transaction_images
be_onboarding_events
be_onboarding_targets
```

Calculation collections are never serialized as client changes. If a changed subtransaction is
selected, its parent transaction is forcibly included; the same rule applies to scheduled children.

Response collections are not grouped. They use `be_transactions`, `be_subtransactions`,
`be_scheduled_transactions`, and `be_scheduled_subtransactions` as separate arrays.

## 8. Merge semantics

The current client treats server objects as replacements interpreted by a converter, not JSON Merge
Patch documents:

1. Look up by collection/entity type plus `id`.
2. If found, convert the entire server object to a detached entity, copy its fields into the
   existing entity, suppress local knowledge increment, then set entity knowledge to zero.
3. If absent and creation is allowed, convert, attach to the identity map, fire an added event, and
   set knowledge to zero.
4. Tombstones are entities with `is_tombstone = true`; the generic merge does not physically remove
   them from the identity map.

Converter behavior defines missing/null semantics:

- an explicitly `null` wire property usually becomes `null`;
- an absent property usually becomes JavaScript `undefined` and can replace the previous value;
- some converters supply a field-specific default such as `false`, `0`, `[]`, or `""`;
- dates are parsed only when truthy and otherwise become `null` in the converters that guard them;
- transaction amounts are rounded with `Math.round` when serialized to the server;
- unknown response fields are ignored by the current materialized entity. A research implementation
  may retain them only in the separately consented, bounded diagnostic envelope defined by the core
  protocol; that envelope is not part of operational state.

A conforming operational cache replaces the complete set of explicitly modeled Version 1 fields for
that entity ID and discards unmodeled fields. It must not merge “missing means unchanged”: a missing
modeled optional field becomes absent in the replacement, while explicit null remains null. The
exact cache-size projection and the separate diagnostic-envelope boundary are defined in
[YNAB_CATALOG_PROTOCOL.md](./YNAB_CATALOG_PROTOCOL.md); no raw response envelope is required or
allowed in the operational cache.

## 9. Collection registry

### 9.1 Catalog

| Collection | Entity type | Wire field inventory |
| --- | --- | --- |
| `ce_users` | user | `id`, `username`, `email`, `trial_days_remaining`, `trial_expires_on`, `initial_intention`, `is_subscribed`, `first_name`, `family_id`, `family_role`, `age_group`, `initial_budget_template`, `sign_in_count`, `annual_subscription_price`, `required_privacy_policy_version`, `self_reported_source`, `is_referral_program_available`, `created_at`, `confirmed_at` |
| `ce_user_budgets` | user budget | `id`, `user_id`, `is_tombstone`, `budget_id`, `budget_version_id`, `budget_name`, `source`, `permissions`, `last_modified_at` |
| `ce_user_settings` | user setting | `id`, `user_id`, `setting_name`, `setting_value` |
| `ce_user_privacy_policy_agreements` | agreement | `id`, `version`, `source`, `client_agreed_at`; converter document key supplies user ID |

### 9.2 Family

| Collection | Entity type | Wire field inventory |
| --- | --- | --- |
| `fe_family` | family singleton | `id`, `is_tombstone` |
| `fe_family_members` | family member | `id`, `family_id`, `is_tombstone`, `user_id`, `first_name`, `email`, `family_role`, `owned_budget_ids`, `shared_budget_ids`, `display_initial`, `sort_index` |

### 9.3 Budget source and calculation collections

The current response merge registry recognizes exactly these keys:

| Response collection | Entity type | Current wire fields read by the converter |
| --- | --- | --- |
| `be_accounts` | account | `id`, `is_tombstone`, `account_type`, `account_name`, `note`, `last_payment_payee_id`, `is_closed`, `sortable_index`, `is_favorite`, `sortable_favorite_index`, `on_budget`, `last_reconciled_at`, `direct_import_status`, `direct_import_institution_name`, `direct_import_account_name`, `direct_import_aggregated_at`, `direct_import_balance`, `direct_import_available_balance`, `debt_start_date`, `debt_original_balance`, `debt_interest_rates`, `debt_minimum_payments`, `debt_asset_values`, `debt_escrow_amounts`, `debt_migrated_from_account_id` |
| `be_account_calculations` | account calculation | `id`, `is_tombstone`, `entities_account_id`, `cleared_balance`, `uncleared_balance`, `info_count`, `warning_count`, `error_count`, `transaction_count`, `debt_last_payment_date`, `debt_payments` |
| `be_account_mappings` | account mapping | `id`, `is_tombstone`, `entities_account_id`, `date_sequence`, `fid`, `hash`, `salt`, `shortened_account_id`, `should_flip_payees_memos`, `should_import_memos`, `skip_import` |
| `be_monthly_account_calculations` | monthly account calculation | `id`, `is_tombstone`, `entities_account_id`, `month`, `cleared_balance`, `uncleared_balance`, `rolling_balance`, `info_count`, `warning_count`, `error_count`, `transaction_count`, `debt_last_payment_date`, `debt_payments`, `debt_interest_paid`, `debt_interest_due`, `debt_escrow_paid`, `debt_estimated_interest_paid`, `debt_estimated_escrow_paid` |
| `be_budget` | budget singleton | `id`, `is_tombstone`, `budget_id`, `budget_name`, `currency_format`, `date_format`, `source` |
| `be_expected_income` | expected income singleton | `id`, `is_tombstone`, `user_entered_income` |
| `be_master_categories` | master category | `id`, `is_tombstone`, `name`, `internal_name`, `note`, `is_hidden`, `sortable_index`, `deletable` |
| `be_money_movements` | money movement | `id`, `is_tombstone`, `entities_money_movement_group_id`, `from_entities_monthly_subcategory_budget_id`, `to_entities_monthly_subcategory_budget_id`, `amount`, `move_started_at`, `move_accepted_at`, `note`, `performed_by_user_id`, `source` |
| `be_money_movement_groups` | money movement group | `id`, `is_tombstone`, `month`, `group_created_at`, `deleted_entities_subcategory_id`, `note`, `performed_by_user_id`, `source` |
| `be_monthly_budgets` | monthly budget | `id`, `is_tombstone`, `month`, `note` |
| `be_monthly_budget_calculations` | monthly budget calculation | `id`, `is_tombstone`, `entities_monthly_budget_id`, `immediate_income`, `budgeted`, `cash_outflows`, `credit_outflows`, `balance`, `over_spent`, `available_to_budget`, `uncategorized_cash_outflows`, `uncategorized_credit_outflows`, `uncategorized_balance`, `additional_to_be_budgeted`, `age_of_money` |
| `be_monthly_subcategory_budgets` | monthly subcategory budget | `id`, `is_tombstone`, `entities_monthly_budget_id`, `entities_subcategory_id`, `budgeted`, `goal_snoozed_at` |
| `be_monthly_subcategory_budget_calculations` | monthly subcategory calculation | `id`, `is_tombstone`, `entities_monthly_subcategory_budget_id`, `cash_outflows`, `credit_outflows`, `budgeted_cash_outflows`, `budgeted_credit_outflows`, `unbudgeted_cash_outflows`, `unbudgeted_credit_outflows`, `positive_cash_outflows`, `budgeted_spending`, `all_spending`, `all_spending_since_last_payment`, `balance`, `balance_previous_month`, `budgeted_previous_month`, `spent_previous_month`, `payment_previous_month`, `budgeted_average`, `spent_average`, `payment_average`, `additional_to_be_budgeted`, `upcoming_transactions`, `upcoming_transactions_count`, `upcoming_transactions_first_date`, `goal_target`, `goal_under_funded`, `goal_overall_funded`, `goal_overall_left`, `goal_overall_outflows`, `goal_percentage_complete`, `goal_expected_completion` |
| `be_onboarding_events` | onboarding event | `id`, `is_tombstone`, `event_name`, `user_id`, `created_at`, `updated_at` |
| `be_onboarding_targets` | onboarding target | `id`, `is_tombstone`, `cadence`, `cadence_day`, `calculated_amount`, `funding_amount`, `spending_breakdown`, `user_amount` |
| `be_payees` | payee | `id`, `is_tombstone`, `entities_account_id`, `name`, `internal_name`, `enabled`, `rename_on_import_enabled`, `auto_fill_amount`, `auto_fill_amount_enabled`, `auto_fill_memo`, `auto_fill_memo_enabled`, `auto_fill_subcategory_enabled`, `auto_fill_subcategory_id`, `auto_fill_user_defined_subcategory_id` |
| `be_payee_locations` | payee location | `id`, `is_tombstone`, `entities_payee_id`, `latitude`, `longitude` |
| `be_payee_rename_conditions` | rename condition | `id`, `is_tombstone`, `entities_payee_id`, `operand`, `operator` |
| `be_scheduled_subtransactions` | scheduled child | `id`, `is_tombstone`, `entities_scheduled_transaction_id`, `entities_payee_id`, `entities_subcategory_id`, `amount`, `memo`, `sortable_index`, `transfer_account_id` |
| `be_scheduled_transactions` | scheduled transaction | `id`, `is_tombstone`, `entities_account_id`, `entities_payee_id`, `entities_subcategory_id`, `date`, `amount`, `memo`, `frequency`, `flag`, `transfer_account_id`, `upcoming_instances`, `debt_transaction_type` |
| `be_settings` | setting | `id`, `setting_name`, `setting_value` |
| `be_subcategories` | category | `id`, `is_tombstone`, `entities_master_category_id`, `entities_account_id`, `name`, `internal_name`, `note`, `type`, `is_hidden`, `sortable_index`, `goal_type`, `goal_needs_whole_amount`, `goal_target_amount`, `goal_target_date`, `goal_created_on`, `goal_cadence`, `goal_cadence_frequency`, `goal_day`, `monthly_funding`, `pinned_index`, `pinned_goal_index` |
| `be_subtransactions` | transaction child | `id`, `is_tombstone`, `entities_transaction_id`, `entities_payee_id`, `entities_subcategory_id`, `amount`, `cash_amount`, `credit_amount`, `credit_amount_adjusted`, `subcategory_credit_amount_preceding`, `memo`, `check_number`, `sortable_index`, `transfer_account_id`, `transfer_transaction_id` |
| `be_transactions` | transaction | detailed in section 10 |
| `be_transaction_images` | transaction image | `id`, `is_tombstone`, `entities_transaction_id` |

`first_month` and `last_month` are response metadata siblings of the `be_*` keys, not entities.

The field table is the inbound converter inventory, not a claim that every field is writable or
always present. Important current asymmetries are:

- `ce_users.trial_days_remaining` and `ce_users.initial_budget_template` are provider/response-only;
  the ordinary user serializer instead sends `trial_expires_on` and omits the template.
- the six `be_accounts.direct_import_*` fields are provider/response-only; the account serializer
  explicitly assigns them `undefined`, so they disappear from outbound JSON;
- `be_scheduled_transactions.upcoming_instances` is an array of date strings inbound, but the
  current outbound serializer emits a PostgreSQL-style brace string such as
  `"{2026-09-01,2026-10-01}"`, or `null`;
- calculation collections are server-authoritative and never serialized as local changes.

## 10. Transaction wire model

```ts
type TransactionTombstoneWire = {
  id: string;
  is_tombstone: true;
  [unknown: string]: unknown;
};

type ActiveTransactionWire = {
  id: string;
  is_tombstone: false;
  entities_account_id: string;
  entities_payee_id?: string | null;
  entities_subcategory_id?: string | null;
  entities_scheduled_transaction_id?: string | null;
  date: string;
  date_entered_from_schedule?: string | null;
  amount: number;
  cash_amount?: number | null;
  credit_amount?: number | null;
  credit_amount_adjusted?: number | null;
  subcategory_credit_amount_preceding?: number | null;
  memo?: string | null;
  cleared: "Cleared" | "Uncleared" | "Reconciled";
  accepted: boolean;
  check_number?: string | null;
  flag?: string | null;
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
  transfer_subtransaction_id?: string | null;
  matched_transaction_id?: string | null;
  ynab_id?: string | null;
  imported_payee?: string | null;
  imported_date?: string | null;
  original_imported_payee?: string | null;
  provider_cleansed_payee?: string | null;
  source: TransactionSource;
  debt_transaction_type?: string | null;
  [unknown: string]: unknown;
};

type TransactionWire = TransactionTombstoneWire | ActiveTransactionWire;
```

The shape above separates sparse tombstones from active rows and marks converter-defaulted or
noncritical fields optional; it is an inbound model, not a server-requiredness claim. The converter
defaults missing/null `cash_amount`, `credit_amount`,
`credit_amount_adjusted`, and `subcategory_credit_amount_preceding` to zero in the materialized
entity. It parses `date` unconditionally, so a non-tombstone transaction without a valid date is a
schema failure for a pending reader. Money is a JSON number in the web wire and rounded to an
integer on write. The browser/NAB bridge must encode money as a decimal string because JSON cannot
carry JavaScript `bigint` and native-message peers may have different integer limits.

Current source enum:

```ts
type TransactionSource =
  | "Scheduler"
  | "raw_import"
  | "raw_pending"
  | "Imported"
  | "Pending"
  | "ImportedPending"
  | "Matched"
  | "matched_import"
  | "matched_pending"
  | null;
```

`getAllTransactions()` returns the entire identity-map collection, including raw staging records
and tombstones. `getVisibleTransactionsByAccountId()` removes tombstones and admits only
`Scheduler`, `Matched`, `Imported`, `ImportedPending`, `Pending`, and `null`. Raw sources and both
`matched_*` imported-side records are not independently displayed.

## 11. Pending/import lifecycle

The current client has two related but distinct stages:

```text
server/provider staging       client-visible/imported state        matched pair
raw_pending  ──import──▶      Pending                         ──▶   Matched + matched_pending
raw_import   ──import──▶      Imported                        ──▶   Matched + matched_import
```

### 11.1 Automatic import

For each non-tombstoned raw record, the import manager:

1. clears the tombstone flag;
2. ordinarily sets `accepted = false`;
3. maps `raw_import` to `Imported` and `cleared = Cleared`;
4. maps `raw_pending` to `Pending` and `cleared = Uncleared`;
5. resolves/creates a payee and may auto-fill a category;
6. attempts a match;
7. merges the edited entity back, which increments local device knowledge.

Therefore a browser snapshot normally sees `Pending`, while a strictly read-only catalog client
may see `raw_pending` because it deliberately skips this mutating transformation. Both are pending
inputs; they are different lifecycle stages.

### 11.2 Match candidates

The current client matches equal-amount candidates up to ten days apart. Its valid source pairs are:

```text
null             + Imported
null             + Pending
null             + ImportedPending
Scheduler        + Imported
Scheduler        + Pending
Scheduler        + ImportedPending
Pending          + Imported
ImportedPending  + Imported
```

Raw pending can initially match only `null` or `Scheduler` candidates. Raw posted import can match
`null`, `Scheduler`, `ImportedPending`, or an existing matched user side.

### 11.3 Creating a match

When an imported/pending record is matched to a user-side record:

- the imported side's `matched_transaction_id` points to the user side;
- its source becomes `matched_import` or `matched_pending`;
- the user side's `matched_transaction_id` points back;
- the user side source becomes `Matched`;
- the user side becomes unaccepted pending review;
- imported metadata/amount/cleared state is copied into the retained side under the client's
  business rules.

This is a two-entity private relationship. Treating `matched_transaction_id` as a public ID is
wrong. `pending-read-v1` never promotes it and emits public IDs as null; only a future
provider-defined, versioned identity binding could change that.

### 11.4 Accepting or rejecting

On match acceptance, the retained user side receives the imported side's `ynab_id`, becomes
accepted, and changes source as follows:

```text
matched_import   -> Imported
matched_pending  -> ImportedPending
```

The imported-side entity is normally tombstoned. Reject/unmatch restores the imported side and its
source, restores saved user-side values, and may tombstone the rejected imported side depending on
the action. Current feature flags can alter whether approval/tombstoning is automatic, so an
independent reader must report observed state, not recreate these writes.

### 11.5 Settlement model

A common inferred path is:

```text
raw_pending -> Pending -> (possibly matched_pending / ImportedPending)
        provider later supplies raw_import
Pending or ImportedPending + Imported -> posted match/consolidation
```

The individual client-side source transitions in sections 11.1–11.4 are WEB-STATIC verified. The
end-to-end provider settlement ordering/timing shown here, whether every intermediate occurs, and
durability or continuity of any particular private ID across provider refresh remain inferred or
unknown. NAB must use private IDs only as observation references and must never authorize a public
write by fuzzy account/date/amount/payee matching.

## 12. Snapshot API implications

The current page-level extraction seam is:

```text
YNABSharedLib.defaultInstance.entityManager.getAllTransactions()
```

A fixed packaged page adapter must:

1. reject absent or wrong-version runtime objects;
2. filter tombstones;
3. accept only the explicitly supported pending source states;
4. validate required types before returning a record;
5. emit public account/transaction IDs as null and public capabilities as false; current catalog
   mappings are not proof of a public-API identity join;
6. apply the browser-bridge section 6 relationship projection against complete, build-pinned active
   account, payee, transaction, and subtransaction indexes: the selected account must resolve and be
   non-tombstoned; absent or null `entities_payee_id` means no payee, while a non-null link must
   resolve to an active payee; direct `transfer_*` state or a resolved payee whose
   `entities_account_id` is non-null is transfer linkage; and any active child is a live split. A
   pending-adjacent transfer, dangling account/payee relationship, or live split returns the exact
   fail-closed bridge error rather than an incomplete row. Match-adjacent state additionally uses
   the bridge's reciprocal peer-graph validation, not a transaction-only shortcut;
7. return no entity object, prototype, callback, raw response, token, or arbitrary field;
8. require the passive, build-pinned bootstrap/backfill/success proof in the browser-bridge contract,
   in addition to pre/post sync/unsaved-state checks; current evidence cannot construct that proof,
   so the reviewed page adapter returns `PAGE_COMPLETENESS_UNPROVEN`;
9. cap count and serialized bytes.

Calling `syncManager.sync*` from an extraction adapter is forbidden. Those methods are
bidirectional and can upload every unsaved official-page edit.

## 13. Error behavior inside the library

The transport wraps both HTTP failures and a JSON response with truthy top-level `error` as a
`YNABServerError`. When the response carries `X-YNAB-Server-Version`, it treats it as an application
server error and recognizes:

```ts
type CatalogApplicationError = {
  error:
    | string
    | {
        id?: string;
        message?: string;
        data?: string;
      };
};
```

`data` is later parsed as JSON when possible. The wrapper also records HTTP status, server request
ID, client request ID, and origin heuristics (application/Heroku/Cloudflare). A production bridge
must not reproduce the current library's verbose error string because it can contain URLs,
identifiers, or provider text. Map it to a closed redacted error union.

Budget/family sync specially recognizes:

- `server_knowledge_of_device_exceeds_device_knowledge`;
- `user_does_not_have_read_permissions`;
- `user_does_not_have_family_read_permissions`.

A 401 clears the in-memory session token. Other private error IDs remain undocumented.

## 14. What is verified versus still unknown

Verified for the current bundle:

- manager topology and call graph;
- all three sync modes and default delta behavior;
- schema values;
- request-side grouping and response-side flattening;
- local entity knowledge selection;
- concurrent-local-edit response suppression;
- converter field inventory and replacement semantics;
- current transaction source/matching transitions;
- UUIDv4 web-device initialization;
- automatic-import side effects.

Still requires a provider contract or controlled fixture:

- server-side retention and paging/backfill limits;
- whether every response collection is always present as `[]`;
- sparse tombstone guarantees;
- pending-ID stability;
- Castle/session/cookie lifetime and binding;
- authoritative header optionality;
- complete private error/rate-limit table;
- cross-version converter compatibility;
- private mutation conflict resolution.

## 15. Exact current method surface

This appendix records the sync-facing methods retained by the current bundle. “Runtime arity” is
JavaScript `Function.length`; decorators and default parameters can make it smaller than the
logical source signature. These method names document the library, not an API NAB should call from
an extraction extension.

### 15.1 `SyncManager`

| Method | Runtime arity | Logical signature or role |
| --- | ---: | --- |
| `initialize` | 1 | `(store)` |
| `onHeartbeat` | 0 | `()` |
| `_onHeartbeatInner` | 0 | `()` |
| `scheduleNextHeartbeat` | 1 | `(delay)` |
| `cancelNextHeartbeat` | 0 | `()` |
| `startAutoSyncing` | 0 | `()` |
| `stopAutoSyncing` | 0 | `()` |
| `flushAndStopSync` | 0 | wait for current work, flush, stop |
| `finalize` | 0 | teardown |
| `syncData` | 0 | `(catalogAndFamily=true, budget=true)` |
| `syncAllDataNow` | 0 | `()` |
| `syncCatalogAndFamilyDataNow` | 0 | `()` |
| `syncBudgetDataNow` | 0 | `()` |
| `syncBudgetDataBackfill` | 0 | `()` |
| `syncDataIfUnsavedChanges` | 0 | `()` |
| `hasUnsavedChanges` | 0 | `()` |
| `getHasUnsavedCatalogEntityChanges` | 0 | `()` |
| `getHasUnsavedBudgetEntityChanges` | 0 | `()` |
| `getCurrentSyncPromise` | 0 | `()` |
| `setCurrentSyncPromise` | 1 | `(promise)` |
| `getConnectionState` | 0 | `()` |
| `setConnectionStateConnected` | 0 | `()` |
| `setConnectionStateDisconnected` | 1 | `(error)` |
| `setLastKnownServerAppVersion` | 1 | `(version)` |
| `onApiRequestCompleted` | 2 | `(response, requestMetadata)` |

Observed getters are `connectionState`, `currentSyncPromise`,
`hasUnsavedBudgetEntityChanges`, `hasUnsavedCatalogEntityChanges`, `isAutoSyncing`,
`isBackfillSyncInProgress`, `isSyncInProgress`, `lastKnownServerAppVersion`, and `store`.

### 15.2 Web store

| Method | Runtime arity | Logical signature or result |
| --- | ---: | --- |
| `initialize` | 1 | `(config)` |
| `getChangedCatalogEntitiesToSync` | 2 | `(startingKnowledge, endingKnowledge)` |
| `getChangedBudgetEntitiesToSync` | 2 | `(startingKnowledge, endingKnowledge)` |
| `handleLoginUserResponse` | 1 | `(response)` |
| `handlePermissionDeniedSyncError` | 1 | `(error)` |
| `handleSyncCatalogDataWithServerResponse` | 2 | `(response, requestSnapshot)` |
| `handleSyncFamilyDataWithServerResponse` | 3 | `(response, requestSnapshot, familySnapshot)` |
| `handleSyncBudgetDataWithServerResponse` | 0 | four logical parameters before decoration |
| `mergeOutgoingServerBudgetEntitiesWithClientBudgetEntities` | 2 | outgoing/incoming materialized entities |
| `performCalculationsLocallyOrOnServer` | 1 | returns server-calculation choice |
| `performFullCalculations` | 0 | returns `true` in web store |
| `performPendingCalculations` | 1 | returns `true` in web store |
| `performPendingCalculationsOnActiveBudget` | 1 | returns `true` in web store |
| `refreshAndSyncActiveFamilyBasedOnUser` | 0 | `()` |
| `setActiveBudget` | 0 | one logical argument before decoration |
| `clearActiveBudget` | 0 | `()` |
| `updateQueueCalculationsForServerEntitiesFlag` | 3 | empty web override |

The three calculation-choice methods make the current web path server-authoritative for
calculated entities.

### 15.3 Base store sync and session methods

| Method | Runtime arity | Logical signature or role |
| --- | ---: | --- |
| `syncCatalogAndFamilyDataWithServer` | 0 | `()` |
| `syncBudgetDataWithServer` | 0 | `(syncType="delta")` |
| `internalSyncBudgetDataWithServer` | 0 | `(budgetVersion, knowledge, syncType="delta")` before decoration |
| `internalSyncFamilyDataWithServer` | 2 | family plus knowledge |
| `makeServerRequestSyncCatalogData` | 1 | request |
| `makeServerRequestSyncFamilyData` | 1 | request |
| `makeServerRequestSyncBudgetData` | 0 | one request before decoration |
| `getCatalogKnowledgeValue` | 1 | knowledge property |
| `getBudgetKnowledgeValue` | 1 | knowledge property |
| `getCatalogKnowledgeValueOfServer` | 0 | `()` |
| `getBudgetKnowledgeValueOfServer` | 0 | `()` |
| `getBudgetKnowledgeCurrentDeviceKnowledge` | 0 | `()` |
| `hasCatalogChangesToSendToServer` | 0 | `()` |
| `hasFamilyChangesToSendToServer` | 0 | always `false` in current model |
| `hasBudgetChangesToSendToServer` | 0 | `()` |
| `throwIfBudgetResponseIsStale` | 1 | active-budget identity check |
| `throwIfUserChangesOutFromUnderUsDuringCall` | 1 | active-user identity check |
| `mergeServerCatalogObjectsToClientEntities` | 1 | optional second argument |
| `mergeServerFamilyObjectsToClientEntities` | 1 | optional second argument |
| `mergeServerBudgetObjectsToClientEntities` | 0 | `(changedEntities, allowCreate=true)` before decoration |
| `conversionFunctionInternal` | 3 | converter dispatch |
| `loginUser` | 2 | `(email, password, remember=false, otp=null)` |
| `loginUserWithSessionToken` | 1 | `(token)` |
| `baseLoginUser` | 1 | request wrapper |
| `baseHandleLoginUserResponse` | 1 | response materialization |
| `logoutUser` | 0 | `(flush=true)` |
| `assertIsLoggedIn` | 0 | optional caller name |

Web persistence hooks `persistCatalogKnowledgeValues`, `persistBudgetKnowledgeValues`, and
`persistFamilyKnowledgeValues` are deliberate no-ops. The three `sync*DataWithLocalStorage`
methods return `false`.

### 15.4 V1 adapter

| Public wrapper | Runtime arity | Catalog operation |
| --- | ---: | --- |
| `loginUserWithSessionToken` | 1 | `getInitialUserData` |
| `login` | 1 | `loginUser` |
| `logout` | 1 | `logoutUser` |
| `syncCatalogDataWithServer` | 1 | `syncCatalogData` |
| `syncFamilyDataWithServer` | 1 | `syncFamilyData` |
| `syncBudgetDataWithServer` | 1 | `syncBudgetData` |
| `createNewBudget` | 1 | `createNewBudget` |
| `deleteBudget` | 1 | `deleteBudget` |
| `freshStartABudget` | 1 | `freshStartABudget` |
| `stageDirectImportData` | 1 | `stageDirectImportData` |
| `unlinkAccountFromDirectImport` | 1 | `unlinkAccount` |
| `recordSubscriptionReceiptToServer` | 1 | `recordSubscriptionReceipt` |
| `initiatePasswordReset` | 1 | `initiatePasswordReset` |
| `resetPassword` | 1 | `resetPassword` |
| `registerNewUser` | 1 | `signupUser` |

Adapter internals are `sendCatalogRequest` (runtime arity 1; logical operation plus optional data),
`hasChangedEntities` (1), `throwIfWriteRequestWhileReadOnly` (2), `buildHeaders` (2), and
`sendServerRequest` (runtime arity 4; logical fifth options/default parameter).
