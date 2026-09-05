# Unofficial YNAB Catalog Protocol: `pending-read-v1`

Status: research specification; not an official or authorized YNAB API  
Snapshot date: 2026-08-30  
Catalog API header: `2026-01-01`  
Schemas: catalog `17`, family `4`, budget `44`

This is the clean-room protocol contract for one deliberately bounded profile: obtain and maintain
the current web entity state needed to list pending transactions, without sending private
mutations. It documents the current web client rather than promising future provider behavior.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used as described in
RFC 2119/RFC 8174. They prescribe a hypothetical conforming client; they do not override the
provider-permission gate.

Companion documents:

- [YNAB_WEB_CLIENT_RUNTIME.md](./YNAB_WEB_CLIENT_RUNTIME.md): current library internals, collections,
  converters, and pending match state machine.
- [NAB_BROWSER_BRIDGE_PROTOCOL.md](./NAB_BROWSER_BRIDGE_PROTOCOL.md): browser/cookie acquisition,
  normalized API, IPC, consent, and credential boundary.
- [YNAB_PROTOCOL_PROVENANCE.md](./YNAB_PROTOCOL_PROVENANCE.md): evidence IDs, hashes, confidence, and
  unresolved facts.
- [YNAB_SHARED_LIBRARY_STATIC_ANALYSIS.md](./YNAB_SHARED_LIBRARY_STATIC_ANALYSIS.md): signed mobile
  shared-core archaeology and version-drift appendix; current web values in the runtime reference
  take precedence.
- [YNAB_SYNC_TEST_BUDGET_VALIDATION_PLAN.md](./YNAB_SYNC_TEST_BUDGET_VALIDATION_PLAN.md): safe live
  validation plan.

## 1. Conformance boundary

### 1.1 Included

`pending-read-v1` specifies:

- current public API behavior relevant to pending transactions;
- authenticated web-session bootstrap;
- catalog, family, budget bootstrap, backfill, and delta reads;
- exact form transport and observed/current client headers;
- three-way knowledge/cursor behavior;
- request and response collection registries;
- the explicitly modeled pending-critical transaction fields read by the reviewed converter, plus
  pending lifecycle semantics;
- replacement/tombstone/cache rules;
- concurrency, retries, errors, version circuit breakers, and crash recovery;
- normalized pending output through the browser bridge.

### 1.2 Excluded

The profile intentionally does not specify or permit:

- private entity writes, import acceptance, matching, approval, editing, or deletion;
- account login with password, SSO, OTP, password reset, signup, plan creation/deletion, Direct
  Import staging, subscription receipt, or account unlink operations;
- bypassing Castle, bot protection, CAPTCHA, throttling, or session controls;
- generic use of the private endpoint;
- a claim that private entity IDs are durable public identifiers.

Those omissions are closed boundaries, not TODOs an implementation may fill by experimentation.

### 1.3 Definition of complete

An implementation conforms only if a clean-room engineer can implement the fail-disabled core and
its conformance decision without inspecting live traffic/source, inventing a cursor transition, or
deciding an unspecified failure policy. This is not a claim that an executable private client can be
enabled from the present evidence: server/provider behaviors labeled `UNKNOWN` and missing signed
contract assets remain hard circuit breakers. The checked-in JSON files are illustrative seed cases,
not a completed executable conformance suite.

## 2. Executive protocol summary

The public and web protocols are separate systems:

| Dimension | Public API | Web catalog |
| --- | --- | --- |
| Base | `https://api.ynab.com/v1` | `https://app.ynab.com/api/v1/catalog` |
| Auth | `Authorization: Bearer` PAT/OAuth | ambient web session + `X-Session-Token` + device/Castle/version headers |
| Style | REST resources | operation-multiplexed form POST |
| Plan key | `plan_id` | `budget_version_id` selected through catalog |
| Delta | one `server_knowledge` cursor | device→server interval plus device's server cursor |
| Writes | explicit POST/PATCH/DELETE schemas | nonempty bidirectional `changed_entities` interval |
| Pending | expressly excluded from transaction-list routes | represented in transaction source lifecycle |
| Stability | documented/supported | private, versioned with the web client, unsupported without permission |

There is no public query flag that reveals pending transactions. `type=unapproved`,
`type=uncategorized`, and `last_knowledge_of_server` only filter the posted/public resource set.
Scheduled transactions are another resource and are not bank-pending transactions.

## 3. Scalar and JSON contract

```ts
type JsonObject = { [key: string]: JsonValue };
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

type WireId = string;          // nonempty Unicode scalar sequence, <=512 UTF-8 bytes; opaque
type FullDate = string;        // /^\d{4}-\d{2}-\d{2}$/ and a valid calendar date
type Timestamp = string;       // RFC 3339 UTC where used
type Knowledge = number;       // Number.isSafeInteger(x) && x >= 0
type SchemaVersion = number;   // Number.isSafeInteger(x) && x >= 0
type MoneyWire = number;       // Number.isSafeInteger(x); milliunits in observed transaction fields

// Produced only after JSON Schema validation with maxProperties: 0 and
// additionalProperties: false. TypeScript alone cannot prove exact emptiness.
declare const exactEmptyBrand: unique symbol;
type ExactEmptyObject = Readonly<Record<string, never>> & {
  readonly [exactEmptyBrand]: true;
};
```

The current JavaScript client stores knowledge and money as `number`; a conforming decoder MUST
reject non-integers and values outside JavaScript's safe integer range. The bridge converts money to
a canonical decimal string. It never serializes `bigint` into JSON.

Every `WireId` is validated before indexing, sorting, or HMAC: it must be a nonempty Unicode
scalar-value sequence of at most 512 UTF-8 bytes. Lone UTF-16 surrogates and invalid UTF-8 are
rejected; normalization form is preserved exactly. Equality compares scalar sequences exactly and
deterministic order compares their encoded UTF-8 bytes unsigned. IDs are never case-folded,
normalized, parsed, or interpreted as authority.

Validation is lexical before ordinary `JSON.parse`/IEEE-754 conversion. Before constructing any
JavaScript string or object, or invoking JCS, the UTF-8- and token-preserving decoder MUST validate
that every decoded JSON string value and every decoded object member name is a sequence of Unicode
scalar values. In a JSON string token, a `\uD800`–`\uDBFF` escape is therefore legal only when it
is immediately followed by a `\uDC00`–`\uDFFF` escape in the same token; lone, reversed, or
otherwise unpaired surrogate escapes are rejected. Invalid UTF-8 is likewise rejected. The signed
provider-policy `maximum_string_utf8_bytes` limit applies separately to every decoded string value
and decoded member name and counts the UTF-8 bytes of that decoded scalar sequence—not quotes,
escape spelling, or source-token bytes. No Unicode normalization is applied.

Duplicate member names are detected before object construction by exact comparison of their decoded
scalar sequences. Thus `"a"` and `"\u0061"` are the same member name and are rejected as a
duplicate even though their source spellings differ. The duplicate-key-aware, token-preserving
decoder MUST also inspect every raw token assigned by schema to `Knowledge`,
`SchemaVersion`, or `MoneyWire`. Knowledge/schema accept only `0|[1-9][0-9]*`; money accepts only
`0|-[1-9][0-9]*|[1-9][0-9]*`. Fractions, exponent notation, leading zeroes, `-0`, and any value
outside `Number.isSafeInteger` are rejected even when a generic JSON parser would round the token or
produce a mathematically integral number. This check applies to requests, responses, fixtures, and
persisted modeled cache state before the value enters JavaScript numeric form. Other numeric fields
follow their field-specific schema and never inherit money/knowledge semantics by accident.

Every other JSON number, including one inside bounded generic data that will be discarded, MUST
decode to a finite IEEE-754 binary64 value under the I-JSON/RFC 8785 number model. Reject overflow
(for example `1e400`), NaN/infinity, and any lexical form whose decoded value is negative zero.
Canonicalization uses RFC 8785's ECMAScript number serialization; implementations MUST NOT preserve
the original numeric spelling as the JCS value. A field declared integer additionally requires
`Number.isSafeInteger`; `trial_days_remaining`, `permissions`, and `sort_index` are safe
non-negative integers when present. This rule makes parser acceptance and cache-size JCS portable.

Request JSON:

- MUST use UTF-8;
- MUST contain no duplicate keys, NaN, infinity, or negative zero;
- MUST omit JavaScript-undefined fields rather than encode a sentinel;
- MUST preserve array order;
- MUST reject unknown request fields before serialization.

Response JSON:

- MUST resolve the signed mode's exact response-shape registry before decoding;
- MUST reject every collection or field not named by that registry;
- unknown data MUST NOT be echoed back to YNAB;
- required-field type changes fail closed;
- the modeled fields needed by this reader live only in its bounded entity cache;
- registry entries may be discarded only when their provider-attested disposition says they have no
  pending-lifecycle, authorization, identity-binding, match, transfer, split, cursor, or completeness
  semantics. If retained for research, they live only in a separately consented, bounded encrypted
  diagnostic fixture, never the operational cache or logs.

The registry asset has this closed schema; every referenced wire-schema asset is another exact
signed JCS asset, never a remote URL:

```ts
type ResponseShapeRegistryV1 = {
  schema: "nab.ynab-response-shape-registry/1";
  api_version: "2026-01-01";
  document_schemas: { catalog: 17; family: 4; budget: 44 };
  unknown_collection_action: "reject_protocol_update";
  unknown_field_action: "reject_protocol_update";
  envelopes: {
    operation: CatalogOperationName;
    top_level_schema_asset_id: string;
  }[];                                  // exactly one per four-operation tuple, in tuple order
  documents: {
    document: "catalog" | "family" | "budget";
    collections: {
      wire_name: string;
      container: "array" | "singleton_or_null";
      entity_schema_asset_id: string;
      disposition:
        | "modeled_by_pending_read_v1"
        | "discarded_provider_attested_no_pending_or_authority_semantics";
      fields: {
        path: (
          | { segment: "property"; name: string }
          | { segment: "array_items" }
        )[];
        entity_schema_pointer: string;
        disposition:
          | "modeled_by_pending_read_v1"
          | "discarded_provider_attested_no_pending_or_authority_semantics";
      }[];
    }[];
  }[];                                  // exactly catalog, family, budget in this order
};
```

Within each document, collection names are unique and raw-UTF-8 sorted. Every entity-schema asset is
a closed duplicate-key-rejecting JSON Schema with `additionalProperties:false`, covers both active
and tombstone forms where applicable, and has the same product parser limits.

`path` is a typed path from one entity root: a `property` segment selects the exact decoded object
member name and `array_items` selects every item of the immediately preceding array. It is nonempty,
starts with `property`, contains `array_items` only where the signed schema says the preceding value
is an array, and has no two consecutive `array_items`. `entity_schema_pointer` is an RFC 6901 JSON
Pointer into that same signed entity-schema asset and MUST resolve to the exact subschema that
validates the value at `path`; it is not a remote `$ref`. Field entries are unique and sorted by the
raw UTF-8 bytes of `JCS(path)`.

For a collection with the discarded collection disposition, `fields` is exactly empty and the
whole schema-validated collection is discarded. For a modeled collection, `fields` is exhaustive:
every object member accepted anywhere by its entity schema has exactly one field entry. A
schema-accepted object/array member with no entry, an entry not accepted by the schema, or a pointer/
path/schema mismatch is `PROTOCOL_UPDATE` before entity construction. A discarded scalar is
validated and dropped. A discarded object/array is validated and dropped as one value and none of
its descendants may be separately materialized; otherwise all accepted descendant members are
listed. `id`, tombstone state, and every member used to select an active/tombstone schema branch are
always modeled.

The registry's modeled set must equal every collection and field materialized in sections 7.4, 8,
and 9. A discarded collection or field may not be referenced by an identity, relationship,
normalizer, completeness proof, authorization decision, error decision, or output. Transactions,
subtransactions, payees, accounts, catalog users/relations, family identities, and budget singleton
can never use the discarded *collection* disposition; every pending-critical field within them must
use the modeled field disposition. Registry/schema mismatch is `PROTOCOL_UPDATE` before candidate
merge. No executable registry or per-field disposition table is currently provider-verified, so
direct catalog modes remain gated rather than treating observed tolerance as completeness proof.

## 4. HTTP transport

### 4.1 Request line and body

```http
POST /api/v1/catalog HTTP/1.1
Host: app.ynab.com
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
```

There are exactly two form fields:

```ts
type CatalogForm = {
  operation_name: CatalogOperationName;
  request_data: string; // RFC 8785 JCS of the exact operation-specific request object
};
```

The normative serializer first validates the closed operation request and emits its RFC 8785 JCS
UTF-8 JSON. It then applies the WHATWG `application/x-www-form-urlencoded` serializer to exactly the
ordered tuple `[("operation_name", operation), ("request_data", JCS-string)]`: UTF-8 input, spaces as
`+`, the form percent-encode set, uppercase hexadecimal escapes, `&` between fields, `=` between each
name/value, and no leading `?` or trailing byte. A client MUST send that entity rather than post JSON
directly. The current web adapter passes an object/JSON string to jQuery; the deterministic profile
above preserves the same two form values while closing ordering/serialization choices. It adds
`X-Requested-With: XMLHttpRequest` for the same-origin XHR.

Normative serializer vector (ASCII/UTF-8 bytes, no trailing newline):

```text
request object JCS:
{"device_info":{"id":"00000000-0000-4000-8000-000000000000"}}

operation:
getInitialUserData

form body:
operation_name=getInitialUserData&request_data=%7B%22device_info%22%3A%7B%22id%22%3A%2200000000-0000-4000-8000-000000000000%22%7D%7D

UTF-8 length: 132
SHA-256: 0a7af108e3685a5344e944ef725cc49930c5e96e63d310addd8580cae2a07070
```

`request_body_max_bytes` in an authorized mode contract counts the bytes of the final UTF-8
`application/x-www-form-urlencoded` entity body after form/percent encoding and before any HTTP
content encoding. The worker MUST compute that exact body, its UTF-8 byte length, and SHA-256 before
requesting a dispatch permit; the browser MAIN-world adapter MUST independently reconstruct all
three immediately before transport. If both sides agree on a proven-exact-empty read body but its
length exceeds the signed ceiling, no dispatch occurs and internal `REQUEST_TOO_LARGE` maps to
bridge `RESPONSE_TOO_LARGE`; the policy/device is terminal because the fixed choreography cannot
fit. Any body/length/digest disagreement, nonempty/unprovable change set, or alternate serializer is
`WRITE_GUARD_VIOLATION`, causes no network dispatch, and destroys the logical device because the
reviewed serializer boundary can no longer be proved.

There is no observed catalog CSRF header. This does not make the endpoint unauthenticated or prove
that any listed header/cookie is independently optional.

### 4.2 Operation names

```ts
type CatalogOperationName =
  | "getInitialUserData"
  | "syncCatalogData"
  | "syncFamilyData"
  | "syncBudgetData";
```

The V1 adapter contains additional private operations listed in the runtime reference. They MUST be
rejected by this profile.

### 4.3 Request headers

| Header | Current client behavior | Profile rule |
| --- | --- | --- |
| `X-YNAB-Client-Request-Id` | Always set to a fresh UUID | REQUIRED; fresh for each physical attempt |
| `X-YNAB-Api-Version` | Set when configured; current value `2026-01-01` | REQUIRED, exact reviewed value |
| `X-YNAB-Device-Id` | Adapter throws if missing | REQUIRED; profile-owned UUIDv4 |
| `X-YNAB-Device-Name` | Optional, URL-encoded | Omit unless provider requires it |
| `X-YNAB-Device-Type` | Optional | Omit unless provider requires it |
| `X-YNAB-Device-OS` | Optional; present in current web context | Use truthful approved value |
| `X-YNAB-Device-OS-Version` | Optional | Omit unless truthfully supplied |
| `X-YNAB-Device-App-Version` | Optional device value; global app value overrides it | Browser supplies current truthful value |
| `X-Castle-Request-Token` | Fresh `Castle.createRequestToken()` when Castle is configured | Opaque, per-request, browser-generated; never synthesize |
| `X-Session-Token` | Set when session token exists | REQUIRED after session seed acquisition |
| `Authorization` | Only V1/adapter modes with `useTokenAuth`; current catalog V1 is false | MUST NOT add in current web profile |
| `X-YNAB-Mobile-App` | Only mobile-header mode | MUST NOT impersonate mobile |
| `X-Requested-With` | Added by same-origin jQuery XHR | Send `XMLHttpRequest` only in an approved browser-equivalent transport |

Ambient cookies applicable to the exact URL are attached by the browser. Their names, necessity,
rotation, and partition rules are not a documented contract.

The table records current-client evidence, not per-request discretion. A conforming bridge mode's
signed `DeviceInfoContractV1`, fixed header projection, realm/origin fields, and asset contracts
determine each optional header as exactly required-with-literal/derived value or omitted. The client
never chooses “omit unless” at runtime, copies a label from another device, or treats current
presence/absence as proof of server optionality. Missing cookie/header semantics keep that mode gated.

### 4.4 Response

Success is JSON. The current adapter extracts only `X-YNAB-Server-Version` from response headers.
It treats a truthy top-level `error` as failure even when the HTTP status is 2xx.

A conforming decoder MUST require a JSON object and an application success value of absent or
`null` `error`. It MUST reject HTML, every redirect, invalid content type,
duplicate keys, oversize bodies, and trailing data.

For a future authorized browser/native mode, response media-type parsing is ASCII
case-insensitive and accepts only `application/json` with no parameter or the sole parameter
`charset=utf-8`; request/response body ceilings and cumulative cache ceilings come from the signed
provider mode/policy contract in the browser-bridge specification. Missing limits make that mode
unavailable. The body is counted in UTF-8 before parse and an excess is a non-commit
`RESPONSE_TOO_LARGE`, never truncation. The page-snapshot projection has its separate fixed limits.
More exactly, the transport validates signed `Content-Encoding`, counts a bounded post-decoding byte
stream (and raw encoded bytes in native mode), then uses a fatal streaming UTF-8 decoder; replacement
characters introduced by a convenience `text()` decoder are forbidden.

## 5. Session and device contract

### 5.1 Credential seed

The web app reads an initial session token from a page meta element, then calls
`getInitialUserData`. Ambient cookies are sent by same-origin XHR, although current client code does
not itself enumerate them.

How the meta token and cookies are initially minted is outside this profile. The bridge may reuse a
user-authenticated dedicated browser session but MUST NOT collect a password, OTP, SSO token, or
bank credential.

### 5.2 Device info

```ts
type DeviceInfo = {
  id: WireId;
  device_name?: string;
  device_type?: string;
  device_os?: string;
  device_os_version?: string;
  browser_name?: string;
  browser_version?: string;
  ynab_app_version?: string;
};

type GetInitialUserDataRequest = {
  device_info: DeviceInfo;
};
```

The current web store generates a fresh UUIDv4 per shared-library initialization. A standalone
logical client MUST generate a distinct UUID and MUST NOT copy the live tab's device ID/cursors.
Whether YNAB authorizes this as a third-party device registration remains a provider gate.

### 5.3 Initial response

```ts
type GetInitialUserDataResponse = {
  error?: null;
  session_token: string;
  user: ActiveCatalogUserWire;
  castle_user_jwt?: string | null;
  user_help_access_initial_jwt?: string | null;
  helpscout_user_hash?: string | null;
  budget_version?: JsonObject | null;
  user_budget?: UserBudgetWire | null;
  [future: string]: JsonValue | undefined;
};
```

The current store requires `session_token` and a convertible active `user`. A tombstone-shaped
initial `user` is not a successful response under this profile: it enters `PROTOCOL_UPDATE`, commits
neither session nor entity state, and destroys the fresh logical device. On a valid response, the
client MUST replace the provisional session token with the returned token before catalog/family
sync. Token replacement and the local session-state transition MUST be atomic.

If the request may have reached the server but the response is lost, rotation state is ambiguous.
The client enters `SESSION_STATE_UNKNOWN` and reacquires through the browser; it does not retry with
blind combinations of old/new material.

## 6. Common sync wire types

```ts
type KnowledgeRequest = {
  schema_version: SchemaVersion;
  schema_version_of_knowledge: SchemaVersion;
  starting_device_knowledge: Knowledge;
  ending_device_knowledge: Knowledge;
  device_knowledge_of_server: Knowledge;
};

type SyncResponse<C extends JsonObject> = {
  error?: null;
  changed_entities: C;
  current_server_knowledge: Knowledge;
  server_knowledge_of_device: Knowledge;
  schema_version_of_response: SchemaVersion;
  schema_version_of_server?: SchemaVersion;
  [future: string]: JsonValue | undefined;
};
```

Cursor names are directional:

```text
Kc = currentDeviceKnowledge   latest local change produced by this device
Ks = serverKnowledgeOfDevice latest local change server acknowledges
Kr = deviceKnowledgeOfServer latest server change atomically published with this device's entity map
```

The outbound local interval is `(Ks, Kc]`:

```text
starting_device_knowledge = Ks
ending_device_knowledge   = Kc
device_knowledge_of_server = Kr
```

The read-only profile owns no local entity changes, so `Kc = Ks = 0` for its entire lifetime. The
final serializer MUST enforce both equality and zero, then enforce the operation-specific empty
change set.

## 7. Operation schemas

### 7.1 Catalog

```ts
type SyncCatalogDataRequest = KnowledgeRequest & {
  user_id: WireId;
  schema_version: 17;
  schema_version_of_knowledge: 17;
  starting_device_knowledge: 0;
  ending_device_knowledge: 0;
  changed_entities: ExactEmptyObject;
};

type CatalogChangedEntitiesResponse = {
  ce_users?: CatalogUserWire[];
  ce_user_budgets?: UserBudgetWire[];
  ce_user_settings?: JsonObject[];
  ce_user_privacy_policy_agreements?: JsonObject[];
  [future: string]: JsonValue | undefined;
};
```

`user_id` is obtained from the initial user entity, never caller input.

### 7.2 Family

```ts
type SyncFamilyDataRequest = KnowledgeRequest & {
  family_id: WireId;
  schema_version: 4;
  schema_version_of_knowledge: 4;
  starting_device_knowledge: 0;
  ending_device_knowledge: 0;
};

type FamilyChangedEntitiesResponse = {
  fe_family?: FamilyWire | null;
  fe_family_members?: FamilyMemberWire[];
  [future: string]: JsonValue | undefined;
};
```

Family sync is omitted when the materialized user has no family ID. It currently has no request
`changed_entities` field.

### 7.3 Budget

```ts
type BudgetSyncType = "bootstrap" | "backfill" | "delta";

type SyncBudgetDataRequest = KnowledgeRequest & {
  budget_version_id: WireId;
  sync_type: BudgetSyncType;
  calculated_entities_included: false;
  schema_version: 44;
  schema_version_of_knowledge: 44;
  starting_device_knowledge: 0;
  ending_device_knowledge: 0;
  changed_entities: ExactEmptyObject;
};
```

`budget_version_id` comes from the catalog's authorized `ce_user_budgets` relation and MUST match
the consent-bound plan. The request builder does not accept it directly from an agent.

For this read profile, “authorized relation” means an active, non-tombstoned `ce_user_budgets`
member whose `user_id`, `budget_id`, and `budget_version_id` exactly match the consent-bound catalog
identity. The reader does not interpret the optional numeric `permissions` bitset because its bit
meanings are unknown. A provider contract may add a permissions predicate; until then, an explicit
server read-permission error overrides relation presence and enters `PERMISSION_DENIED`.

```ts
type BudgetChangedEntitiesResponse = {
  first_month?: FullDate | null;
  last_month?: FullDate | null;
  be_budget?: BudgetWire | null;
  be_expected_income?: JsonObject | null;
  be_accounts?: AccountWire[];
  be_account_calculations?: JsonObject[];
  be_account_mappings?: JsonObject[];
  be_master_categories?: JsonObject[];
  be_monthly_account_calculations?: JsonObject[];
  be_monthly_budgets?: JsonObject[];
  be_monthly_budget_calculations?: JsonObject[];
  be_monthly_subcategory_budgets?: JsonObject[];
  be_monthly_subcategory_budget_calculations?: JsonObject[];
  be_money_movements?: JsonObject[];
  be_money_movement_groups?: JsonObject[];
  be_onboarding_events?: JsonObject[];
  be_onboarding_targets?: JsonObject[];
  be_payees?: PayeeWire[];
  be_payee_locations?: JsonObject[];
  be_payee_rename_conditions?: JsonObject[];
  be_scheduled_transactions?: JsonObject[];
  be_scheduled_subtransactions?: JsonObject[];
  be_settings?: JsonObject[];
  be_subcategories?: JsonObject[];
  be_transactions?: TransactionWire[];
  be_subtransactions?: SubTransactionWire[];
  be_transaction_images?: JsonObject[];
  [future: string]: JsonValue | undefined;
};
```

Request writes, which this profile forbids, use `be_transaction_groups` and
`be_scheduled_transaction_groups`. Responses are flat and use the four arrays shown above. A client
MUST NOT echo response collections into a later request.

`first_month` and `last_month` are one atomic metadata pair. Both absent means “no range metadata
change.” Both null means “known empty range.” Two valid full dates mean a known range and require
`first_month <= last_month`. Exactly one present, a null/string mix, an invalid date, or reversed
order rejects the response before merge. These month bounds are stored as protocol metadata only;
they do not substitute for the normalized transaction-date bounds or prove retention.

### 7.4 Required materialization schemas

These are the minimum pending-critical shapes a `pending-read-v1` implementation materializes.
They are closed about which fields drive this profile, not a claim of server-side requiredness.
Fields not used by this profile are inventoried in the runtime reference, validated only as bounded
JSON values, and never written back. Tombstones may be sparse.

```ts
type TombstoneWire = {
  id: WireId;
  is_tombstone: true;
  [future: string]: JsonValue | undefined;
};

type ActiveCatalogUserWire = {
  id: WireId;
  is_tombstone?: false;
  username?: string | null;
  email?: string | null;
  family_id?: WireId | null;
  family_role?: string | null;
  first_name?: string | null;
  is_subscribed?: boolean;
  trial_expires_on?: Timestamp | null;
  trial_days_remaining?: number | null;        // safe non-negative integer; response-only
  initial_budget_template?: JsonObject | null; // current response-only field
  [future: string]: JsonValue | undefined;
};
type CatalogUserWire = TombstoneWire | ActiveCatalogUserWire;

type ActiveUserBudgetWire = {
  id: WireId;
  is_tombstone: false;
  user_id: WireId;
  budget_id: WireId;
  budget_version_id: WireId;
  budget_name?: string;
  permissions?: number;                       // safe non-negative integer if present; bits unknown
  source?: string | null;
  last_modified_at?: Timestamp | null;
  [future: string]: JsonValue | undefined;
};
type UserBudgetWire = TombstoneWire | ActiveUserBudgetWire;

type ActiveFamilyWire = { id: WireId; is_tombstone: false };
type FamilyWire = TombstoneWire | ActiveFamilyWire;

type ActiveFamilyMemberWire = {
  id: WireId;
  is_tombstone: false;
  family_id: WireId;
  user_id: WireId;
  first_name?: string;
  email?: string;
  family_role?: string | null;
  owned_budget_ids?: WireId[];
  shared_budget_ids?: WireId[];
  display_initial?: string;
  sort_index?: number;                         // safe non-negative integer
  [future: string]: JsonValue | undefined;
};
type FamilyMemberWire = TombstoneWire | ActiveFamilyMemberWire;

type ActiveBudgetWire = {
  id: WireId;
  is_tombstone: false;
  budget_id: WireId;
  budget_name?: string;
  date_format?: JsonObject | null;
  currency_format?: JsonObject | null;
  source?: string | null;
  [future: string]: JsonValue | undefined;
};
type BudgetWire = TombstoneWire | ActiveBudgetWire;

type ActiveAccountWire = {
  id: WireId;
  is_tombstone: false;
  account_type?: string;
  account_name?: string;
  on_budget?: boolean;
  is_closed?: boolean;
  note?: string | null;
  direct_import_status?: string | null;       // current response-only fields
  direct_import_institution_name?: string | null;
  direct_import_account_name?: string | null;
  direct_import_aggregated_at?: Timestamp | null;
  direct_import_balance?: MoneyWire | null;
  direct_import_available_balance?: MoneyWire | null;
  [future: string]: JsonValue | undefined;
};
type AccountWire = TombstoneWire | ActiveAccountWire;

type ActivePayeeWire = {
  id: WireId;
  is_tombstone: false;
  name?: string;
  entities_account_id?: WireId | null;
  internal_name?: string | null;
  enabled?: boolean;
  [future: string]: JsonValue | undefined;
};
type PayeeWire = TombstoneWire | ActivePayeeWire;

type ActiveSubTransactionWire = {
  id: WireId;
  is_tombstone: false;
  entities_transaction_id: WireId;
  [future: string]: JsonValue | undefined;
};
type SubTransactionWire = TombstoneWire | ActiveSubTransactionWire;

```

`be_account_mappings` describes Direct Import/provider mapping state. It is not required to classify
pending rows and is not proof of a public-API account ID join, so this profile treats its members as
bounded opaque objects. Public/private identity requires the provider-defined binding specified by
the browser bridge.

## 8. Transaction and pending schemas

```ts
type ClearedState = "Cleared" | "Uncleared" | "Reconciled";

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

type ActiveTransactionWire = {
  id: WireId;
  is_tombstone: false;
  entities_account_id: WireId;
  entities_payee_id?: WireId | null;
  entities_subcategory_id?: WireId | null;
  entities_scheduled_transaction_id?: WireId | null;
  date: FullDate;
  date_entered_from_schedule?: FullDate | null;
  amount: MoneyWire;
  cash_amount?: MoneyWire | null;
  credit_amount?: MoneyWire | null;
  credit_amount_adjusted?: MoneyWire | null;
  subcategory_credit_amount_preceding?: MoneyWire | null;
  memo?: string | null;
  cleared: ClearedState;
  accepted: boolean;
  check_number?: string | null;
  flag?: string | null;
  transfer_account_id?: WireId | null;
  transfer_transaction_id?: WireId | null;
  transfer_subtransaction_id?: WireId | null;
  matched_transaction_id?: WireId | null;
  ynab_id?: WireId | null;
  imported_payee?: string | null;
  imported_date?: FullDate | null;
  original_imported_payee?: string | null;
  provider_cleansed_payee?: string | null;
  source: TransactionSource;
  debt_transaction_type?: string | null;
  [future: string]: JsonValue | undefined;
};

type TransactionWire = TombstoneWire | ActiveTransactionWire;
```

For a non-tombstone transaction, `id`, account linkage, date, integer amount, source, accepted, and
cleared are required by the `pending-read-v1` decoder. A tombstone requires only `id` and
`is_tombstone = true` for cache deletion; other fields are ignored after type-safe envelope parsing.

### 8.1 State classification

| Source/state | Meaning | Visible/budget behavior | Default pending output |
| --- | --- | --- | --- |
| `raw_pending` | hidden provider staging before client import transform | no budget/balance effect | Include for direct catalog completeness; label raw staging |
| `Pending` | provider-pending record materialized by web client | pending section; no budget/balance effect | Include |
| `matched_pending` | hidden imported side paired with a visible `Matched` row | represented by match; do not double count | Never emit alone; use it to classify its visible peer |
| `ImportedPending` | user entered/accepted provisional row | ordinary register row with pending marker; affects plan like entered transaction | Optional `include_entered_provisional` |
| `Matched` with counterpart `matched_pending` | proposed visible/user side of pending match | one represented amount | Include once only after pinned-runtime/provider confirmation |
| `raw_import`, `Imported`, `matched_import` | posted-import lifecycle | not pending | Exclude |

`accepted` is orthogonal. A client MUST NOT require `accepted === false` to classify a transaction
as pending. `cleared === "Uncleared"` is also insufficient because ordinary posted rows may be
uncleared.

### 8.2 Relationship rules

The proposed Version 1 match graph is closed:

```text
Matched <-> matched_pending   pending pair
Matched <-> matched_import    posted pair
```

Static code establishes the source vocabulary and possible relationship, but not the exact
winner/loser representation across all server/runtime permutations. Therefore the following rules
are executable only when the signed mode's `matched_pending_shape_contract` confirms them for the
pinned build. Without it, the presence of any live `Matched`, `matched_import`, or
`matched_pending` row is `PROTOCOL_UPDATE`, not a partial success. Under that gate, every such row
MUST have a non-null match ID that
resolves a live reciprocal peer in one of those two exact source pairs. A missing/null/tombstoned,
self-referential, asymmetric, multi-target, or other-source peer is `PROTOCOL_CHANGED`. Conversely,
every other live source (`null`, `Scheduler`, `raw_import`, `raw_pending`, `Imported`, `Pending`, or
`ImportedPending`) MUST have `matched_transaction_id == null`; a non-null value is an unsupported
relationship and fails the whole query. A resolved reciprocal `Matched` + `matched_import` pair is a
posted match and both sides are excluded. A valid pending pair returns one
normalized amount and marks the hidden side represented. It MUST NOT assume either private ID is a
public transaction ID. This profile never emits a public ID.

For a valid pair, the visible `Matched` row is authoritative for normalized private entity ID,
account, date, amount, cleared/accepted state, payee, memo, and display/import text. The hidden
`matched_pending` row contributes only typed lineage. Both rows MUST name the same private account
and exact integer amount and MUST point to each other; otherwise the whole query fails
`PROTOCOL_CHANGED`. Different dates are permitted because current matching allows a ten-day window,
but the visible row's date is emitted. Missing optional text remains null; it is not filled from the
hidden peer.

### 8.3 Transition summary

```text
raw_pending --official client import--> Pending
Pending + user/scheduled row --match--> Matched + matched_pending
accept pending match --> retained ImportedPending + tombstoned hidden side
Pending or ImportedPending + later Imported --> posted match/consolidation
edit/Enter Now on unmatched Pending --> ImportedPending (or source null if DI no longer active)
reject/delete --> tombstone and/or ImportedPending suppression state
```

The first four transitions are present in the current matching/import implementation; exact server
timing and private-ID continuity across the provider refresh remain unknown.

## 9. Collection and identity semantics

The current converter-read field inventory for every response collection is in the runtime
reference. To make cache limits and conformance deterministic, the Version 1 operational cache
materializes exactly:

- the single active bound catalog user and, after selection, the single active consent-bound
  user-budget relation (the relation collection is empty while awaiting the first catalog sync);
- the requested family singleton/members while family is available;
- budget singleton, accounts, payees, transactions, and the minimal
  subtransaction identity/parent link needed to detect unsupported live split children;
- first/last-month metadata under its atomic pair rule;
- no other collection. Account mappings, calculations, categories, settings, images, scheduled
  entities, money movements, onboarding entities, all other listed arrays/singletons, and unknown
  fields/collections are validate-then-discard. They are never sent back.

For modeled entities, the cache stores exactly the explicitly named fields in sections 7.4 and 8.
`[future]` is notation for a field that may be admitted only by the exact signed registry and is
discarded only under its provider-attested no-pending/no-authority disposition; it is not default
forward tolerance. A known discarded collection must
still have its documented array/singleton container type; each member/value must satisfy the signed
provider-policy JSON depth/property/array/string limits and body bound. Because discarded objects have no operational identity,
Version 1 does not require their `id`, check duplicate entity IDs, or perform referential validation
inside them. Unknown fields receive only bounded generic-JSON validation. Duplicate JSON object keys
are always rejected by the lexical parser before this distinction.

Identity key is `(document identity, collection/entity type, entity.id)`. IDs from different plans
or collections are not interchangeable.

The cache-size input is not implementation-defined. After each candidate merge, construct exactly
one of these internal projections. These objects never cross Native Messaging, enter logs, or become
diagnostic fixtures:

```ts
type CacheKnowledgeProjectionV1 = {
  schema_version_of_knowledge: SchemaVersion;
  current_device_knowledge: 0;
  server_knowledge_of_device: 0;
  device_knowledge_of_server: Knowledge;
};

type CatalogCacheSizeProjectionV1 = {
  schema: "nab.catalog-cache-size/1";
  document: "catalog";
  document_schema_version: 17;
  knowledge: CacheKnowledgeProjectionV1;
  identity:
    | {
        selection: "awaiting_catalog";
        bound_user_id: WireId;
        selected_budget_id: null;
        selected_budget_version_id: null;
      }
    | {
        selection: "selected";
        bound_user_id: WireId;
        selected_budget_id: WireId;
        selected_budget_version_id: WireId;
      };
  collections: {
    ce_users: ActiveCatalogUserWire[]; // exactly one active bound user in both selection states
    // [] iff identity.selection == "awaiting_catalog"; exactly one active relation iff "selected"
    ce_user_budgets: ActiveUserBudgetWire[];
  };
};

type FamilyCacheSizeProjectionV1 = {
  schema: "nab.family-cache-size/1";
  document: "family";
  document_schema_version: 4;
  knowledge: CacheKnowledgeProjectionV1;
  identity: {
    family_id: WireId | null;
    family_state: "absent" | "available" | "unavailable";
    unavailable_reason: null | "permission_error" | "matching_family_tombstone";
  };
  collections: {
    fe_family: FamilyWire[];            // zero or one singleton
    fe_family_members: FamilyMemberWire[];
  };
};

type BudgetCacheSizeProjectionV1 = {
  schema: "nab.budget-cache-size/1";
  document: "budget";
  document_schema_version: 44;
  knowledge: CacheKnowledgeProjectionV1;
  identity: {
    budget_id: WireId;
    budget_version_id: WireId;
    initialization: "bootstrap_partial" | "ready";
  };
  range: {
    first_month: FullDate | null;
    last_month: FullDate | null;
  };
  collections: {
    be_budget: BudgetWire[];            // exactly one active singleton when exposable
    be_accounts: AccountWire[];
    be_payees: PayeeWire[];
    be_transactions: TransactionWire[];
    be_subtransactions: SubTransactionWire[];
  };
};

type CacheSizeProjectionV1 =
  | CatalogCacheSizeProjectionV1
  | FamilyCacheSizeProjectionV1
  | BudgetCacheSizeProjectionV1;
```

For this projection, every entity is first reduced to exactly the explicitly named fields of its
Version 1 type in sections 7.4 and 8: every registry-admitted discarded field is removed; a present optional property is retained with its exact value, an absent optional property
is omitted, and explicit null stays null. Tombstones reduce to exactly
`{"id": id, "is_tombstone": true}`. Every collection is present, even when empty, and is sorted by
the raw UTF-8 bytes of `id`; duplicate IDs have already failed validation. The family projection is
always present. `absent` requires null ID, null reason, zero knowledge, and empty collections.
`available` requires a non-null ID, null reason, and exactly one active matching `fe_family`.
`unavailable/permission_error` requires the denied family ID, zero knowledge, and empty collections
because permission loss destroys that document cache. `unavailable/matching_family_tombstone`
requires the requested ID, response-checkpointed knowledge, exactly its one tombstone sentinel in
`fe_family`, and only previously retained tombstone sentinels (no active rows) in
`fe_family_members`. No other state/reason combination is valid. Budget range is always present and
follows the atomic null/null-or-date/date rule.
The initial-user/session commit uses catalog `selection = "awaiting_catalog"`, contains exactly its
one active bound user and an empty relation array, and is checked against the catalog limit before
commit. In every valid catalog projection, `ce_users` contains exactly that one active bound user.
`selection = "awaiting_catalog"` requires `ce_user_budgets = []`; `selection = "selected"` requires
exactly one active relation matching the selected budget and budget-version identity. These
cardinalities are biconditional, not comments that an implementation may weaken. Only a validated
catalog candidate with exactly one matching active relation may switch the projection to
`selection = "selected"`; non-authoritative bootstrap budget metadata is never used to fill it. A
candidate that tombstones a required catalog identity is rejected under section 10.1 and is never
converted into a cache-size projection.

Entity count is exactly the sum of the lengths of every `collections` array; singleton arrays count
zero or one. It does not count metadata, identities, or discarded collections. Byte count is the
UTF-8 length of RFC 8785 JCS applied to the entire matching `CacheSizeProjectionV1`, including
schema, knowledge, identity, range/state metadata, empty arrays, active entities, and tombstone
sentinels. This exact construction is the only input to the signed per-document cache byte limit.

Apply a response in this order inside the cache transaction:

1. validate the full envelope, versions, all cursors, collection container types, duplicate IDs,
   and transport/body/parser/per-object limits that are decidable before merge;
2. replace each tombstoned identity with the exact sentinel `{id, is_tombstone: true}` and remove it
   from every active index; do not physically delete the sentinel during the logical device lifetime;
3. upsert all non-tombstone raw entity objects as complete replacements;
4. rebuild account/payee/transaction/match indexes plus the active-subtransaction children-by-parent
   index used only to reject unsupported pending splits;
5. validate the complete candidate match graph under section 8.2. Every pending-critical match link
   is required and exact; a broken graph rejects the response before cursor advance. Optional
   schedule/category links and payee links on rows outside the selected pending graph may remain
   null/unresolved but are never invented. `ActiveTransactionWire.entities_account_id` is a
   required link, never part of that optional exception; every pending-adjacent row/peer selected by
   a query is resolved against the active account index under section 17 before output;
6. construct the complete post-merge `CacheSizeProjectionV1` and validate its cumulative entity/JCS
   byte limits; an excess rejects the candidate before any cursor publication;
7. store response schema numbers and known range metadata, not a raw response body;
8. advance cursor according to the mode;
9. commit.

The only apparent exception to sentinel retention is not a merge: a family permission-error branch
deauthorizes and cryptographically destroys that whole document cache without accepting a response.
A matching family tombstone is an accepted merge and therefore retains its sentinel exactly as
specified below.

Collection absence and `[]` both mean no returned changes for that collection. A singleton `null`
means no returned singleton change, not deletion; deletion is represented by an entity tombstone.

Non-tombstone entity objects are full converter inputs, not patches. Missing properties do not mean
“retain old field.” Replace the stored object. For pending-critical entities, missing required
properties fail the whole response before cursor advance.

When authorization logic says a catalog relation is “missing,” it means absent from the complete
post-merge catalog identity map or represented there by a tombstone. Mere absence from a sparse
delta `changed_entities` bag means no change and never revokes access.

After every candidate merge but before cursor commit, construct the projection above and enforce its
exact entity count and JCS UTF-8 byte length against the signed per-document `cache_limits` in the
browser-bridge provider policy. Tombstones and the minimal subtransaction map count;
registry-classified discarded fields/collections do not. Missing limits or a missing/unrecognized
registry keep private mode gated. An excess rejects the whole
candidate with `RESPONSE_TOO_LARGE`, leaves the old cache/cursor intact, and quarantines/destroys the
logical device; eviction and partial success are forbidden.

## 10. State machine

```text
DISCONNECTED
    │ browser supplies session seed + fresh device
    ▼
SESSION_BOOTSTRAP ──getInitialUserData──▶ CATALOG_SYNC
    │ definite auth failure / ambiguous loss    │
    ├──▶ REAUTH_REQUIRED / SESSION_STATE_UNKNOWN├──syncCatalogData──▶ FAMILY_SYNC_OR_SKIP
                                             │
                                             ▼
                                      BUDGET_BOOTSTRAP
                                             │ merge, do not checkpoint Kr
                                             ▼
                                      PARTIAL_BACKFILL
                                             │ backfill start=end=0
                                             ▼
                                           READY
                                             │ profile-owned scheduler only, single flight
                                             ▼
                                          DELTA_SYNC
                                             └──────────────▶ READY
```

Terminal/circuit-breaker states:

```text
REAUTH_REQUIRED        401, invalid/expired session, login redirect
PROTOCOL_UPDATE        426 client_app_update_required, API/schema mismatch
PERMISSION_DENIED      bound user or selected budget read authorization revoked
QUARANTINED            cursor regression, impossible device knowledge, corrupt cache
SESSION_STATE_UNKNOWN  bootstrap token rotation may have occurred without response
READ_RESULT_UNKNOWN    dispatched read lost its response; server replay semantics unknown
AMBIGUOUS_COMMIT       serialized request was not provably read-only; device is permanently stopped
```

### 10.1 Session, catalog, and family

After `getInitialUserData` succeeds, the browser bridge first proves that HMAC of returned `user.id`
equals the consent-bound account fingerprint. It then completes the bridge's two-phase token commit,
materializes only that user, and initializes catalog knowledge to `Kc = Ks = Kr = 0`, schema `17`.
Do not use optional bootstrap budget metadata as the authoritative plan binding. A mismatch is
`WRONG_ACCOUNT_OR_PLAN`, commits neither entity state nor cursor, and destroys the logical device.

Catalog sync has no `sync_type`. For the fresh reader it sends zero start/end, empty
`changed_entities`, and the current catalog `Kr`. On a valid response with
`server_knowledge_of_device = 0`, atomically apply catalog replacements/tombstones and then set
catalog `Kr = current_server_knowledge`; catalog `Kc` and `Ks` remain zero.

As part of validating every catalog candidate, reconcile identity and authorization before commit
and before any family/budget request:

- a changed `ce_users.family_id` clears the old family cache/cursor; a non-null replacement creates
  fresh family knowledge at schema `4`;
- zero active relations matching the consent-bound budget/version HMAC tuple invalidates the active
  budget and enters `PERMISSION_DENIED`; a raw relation-row ID is cache identity, not consent
  authority, so a tombstoned old row plus exactly one active replacement with the same tuple is
  accepted;
- a different budget/version tuple never substitutes for the bound tuple or becomes an in-grant
  plan switch;
- every unselected relation is discarded after bounded validation; Version 1 retains exactly the
  one selected relation and never accepts an agent-supplied raw ID.

Before committing a catalog response, the complete candidate user map MUST contain exactly one
active `ActiveCatalogUserWire` whose ID is the requested bound user ID. A tombstone for that bound
user, or its absence from the complete post-merge map, rejects the catalog candidate without cursor
advance, invalidates all family/budget views, enters terminal `PERMISSION_DENIED`, and destroys the
logical device. Omission from a sparse `changed_entities` bag remains “no change”; only the complete
post-merge map is authoritative. Every active input `ce_users` member must have the requested bound
user ID, and every active input `ce_user_budgets` member must have structurally valid IDs and name
that user even when it will be discarded. In the complete candidate relation map, exactly one
active relation must have both HMAC(budget ID) equal to the consent-bound private-budget fingerprint
and HMAC(budget-version ID) equal to the consent-bound plan-version fingerprint. Zero matches enters
`PERMISSION_DENIED`; more than one is `PROTOCOL_CHANGED`. The selected relation's raw IDs become the
immutable send-time budget binding. Any mismatch rejects the complete response before merge/cursor
advance. The relation row's own `id` remains only an entity-map key and is not persisted as an
authority-bearing selected ID. Its tombstone matters only through the complete map producing zero,
one, or multiple tuple matches under the rule above. Unrelated tombstones and registry-discarded
collections cannot create a selectable identity.

Family sync is skipped when the current user has no family ID. Otherwise it sends the fresh/current
family `Kr` and no `changed_entities`. A valid response is atomically merged before family
`Kr = current_server_knowledge`; `Kc = Ks = 0` remain. A matching family tombstone and
`user_does_not_have_family_read_permissions` are two distinct atomic unavailable transitions; neither
selects another family. The marker is the closed tuple
`family_unavailable_for = {family_id: requested_family_id, reason:
"matching_family_tombstone" | "permission_error"}`.

For the matching-tombstone branch, validate the complete response first, set `Kr` to its
`current_server_knowledge`, retain exactly the matching family tombstone plus every already-retained
member tombstone sentinel, discard every active family/member row, set the tombstone reason, size-
check that exact unavailable projection, and commit marker/cache/cursor together. The tombstone is
therefore counted and retained for the logical-device lifetime even though the active family view is
empty. For the permission-error branch, there is no trustworthy response cursor: cryptographically
destroy the family document/cache, reset its knowledge to zero, create the empty permission-error
projection, and commit the marker. No tombstone is invented.

In either branch,
pending budget reads may continue only if the post-catalog bound budget relation remains active.
Later full refreshes skip family while that exact marker remains. The marker clears only when the
catalog family ID changes, a new grant/device is created, or a signed provider rule explicitly
authorizes a retry. A permitted same-ID retry resumes from the stored tombstone `Kr` for the
tombstone branch or zero for the permission branch; an active replacement may overwrite the same
identity, but the marker and unavailable projection clear only in the atomic successful response
commit. It is never cleared by caller demand or elapsed time.

Before a family merge, every present non-null `fe_family` singleton—active or tombstone—must have
`id == requested_family_id`; a different ID is `PROTOCOL_CHANGED`, rejects without merge/cursor
advance, and destroys the device. Every active `fe_family_members` row must name that family ID. Only
a matching family tombstone takes the handled unavailable path. Before a budget merge, every
present non-null `be_budget`—active or tombstone—must have
`id == requested_budget_version_id`; an active value must additionally have
`budget_id == selected_catalog_budget_id`. A different singleton ID/budget ID is
`PROTOCOL_CHANGED`; only a matching tombstone enters `PERMISSION_DENIED`. All branches reject before
merge/cursor advance and use the immutable send-time binding snapshot.

Routine full refresh is strictly catalog, then family-if-present-and-available, then budget. Any
earlier failure or identity invalidation prevents every later request except the exact handled
family-permission branch above; after recording that marker, the same refresh may continue to budget
only with the still-active bound catalog relation. Other family errors block budget. The three
document commits are individually atomic, not one cross-document database transaction.

### 10.2 Budget bootstrap

Budget bootstrap sends `sync_type = "bootstrap"`, `Kc = Ks = Kr = 0` for a new device. It merges the
response but MUST NOT set `Kr` from that response. The post-merge candidate MUST contain exactly one
active `be_budget` matching the selected budget/version IDs; omission from an initially empty map is
`PROTOCOL_CHANGED`, while a selected tombstone is `PERMISSION_DENIED`. Only then mark the cache
`bootstrap_partial`.

### 10.3 Budget backfill

Backfill sends `sync_type = "backfill"` and forcibly sends start/end zero. For a fresh read-only
device `Kr` is still zero. On successful merge, set:

```text
require response.server_knowledge_of_device == 0
Kc = Ks = 0
Kr = response.current_server_knowledge
schemaVersionOfKnowledge = schema_version_of_response
state = ready
```

Backfill and every later delta require that the post-merge budget map still contains that one active
matching singleton. Sparse omission means no change only because bootstrap already established it.
Tombstone/missing/multiple/mismatched state never reaches `READY` and follows the failure rules
above.

The current general-purpose web client can adopt a positive server acknowledgement when its local
`Kc` is zero. This stricter profile owns a fresh logical device and never emits changes, so a
positive acknowledgement indicates device reuse or a changed server contract and quarantines.

One backfill request completes the current web client's two-step flow; there is no observed
continuation token. “Ready” means complete under this observed protocol response, not a provider
guarantee of unlimited historical retention.

### 10.4 Budget delta

Routine refresh sends `sync_type = "delta"`, `Kc = Ks = 0`, and current `Kr`. After a fully validated
and atomically committed response, update `Kr` to `current_server_knowledge` and schema knowledge to the
response schema.

A read-only client does **not** run the official automatic import transformation. It must therefore
classify `raw_pending` directly. Running the automatic importer would create local entities, advance
`Kc`, and violate the profile.

## 11. Cursor validation and crash consistency

Before every request:

```text
Number.isSafeInteger(Kc, Ks, Kr) and all >= 0
Kc == Ks == 0
schemaVersionOfKnowledge == configured schema
changed_entities is exactly empty where present
```

The exact-empty check runs over the final operation object and again over the decoded
`request_data` extracted from the final form body. Any nonempty, unknown, duplicate, unparsable, or
otherwise not-provably-exact-empty outbound change field is `AMBIGUOUS_COMMIT` even when caught
before transport: no permit is requested, no network bytes are sent, and the logical device is
permanently destroyed. This name reflects loss of the read-only proof, not a claim that a server
mutation actually occurred.

Before committing a response:

```text
response.schema_version_of_response == configured schema
response.schema_version_of_server is absent or == configured schema
response.schema_version_of_response >= prior schemaVersionOfKnowledge
response.current_server_knowledge >= prior Kr
response.server_knowledge_of_device <= Kc
all response knowledge values are safe non-negative integers
```

When `schema_version_of_server` is present it is parsed with the same lexical safe-integer rule and
MUST equal the configured document schema. Absent is allowed because the current field is optional;
any older or newer value is `PROTOCOL_UPDATE` before entity merge/cursor advance. There is no
warning-only or downgrade branch.

The current web client tolerates `server_knowledge_of_device > Kc` only when `Kc == 0`, then raises
`Kc` to the server value. A fresh read-only logical device should never need this. This profile
quarantines instead, because a positive value implies the device identity was reused or the server
contract changed.

Publication rule: entity replacements MUST commit before or atomically with the cursor advance.
For a persistent transport, “commit” is durable: a two-transaction implementation may commit
entities with the old cursor, then commit the cursor; crash replay is safe because replacement/
tombstone application is idempotent. Advancing the durable cursor first is nonconforming.

The Version 1 browser-catalog transport is a volatile epoch and has no persistent entity/cursor
store. It constructs a complete cloned candidate map and cursor tuple, validates both, then swaps one
in-memory root reference so readers can observe either the old complete pair or the new complete
pair, never a mixture. If the worker/port/document terminates before or after that swap, the UUID,
map, and cursor are all discarded together and can never be reconstructed or reused; a later epoch
starts at zero with a new UUID. This atomic in-memory publication conforms precisely because no
cursor can survive without its matching map. Any future transport that persists either side must
use the durable/crash-replay rule above.

## 12. Concurrency

- One session bootstrap per browser credential seed.
- One catalog/family/budget sync worker per logical device.
- Catalog then family then budget ordering for full refresh.
- One in-flight request per document.
- Multiple CLI callers coalesce onto the same promise/result.
- A plan/user/budget-version switch is not an operation inside a grant. It obtains the lock,
  invalidates the grant and old state, and requires a new consent ceremony, fresh UUID, and zero
  bootstrap/backfill; it never reuses old cursors.
- Response identity is bound to the user, family, and budget-version snapshot captured before send.
  If any changes before response, discard response without advancing cursor.
- No agent may cancel after transport in a way that skips response/cursor handling. A timeout after
  dispatch retains old state and enters `READ_RESULT_UNKNOWN`; it is not silently replayed.

The official page ignores an incoming catalog/family or delta response if a local edit increments
device knowledge while the request is in flight. The isolated read-only profile has no local edits,
so observing that condition is a quarantine event.

## 13. Retry, throttling, and cadence

Current web adapter behavior (`WEB-STATIC`):

- if a failed response has a decimal-digits-only `Retry-After` header, wait that many integer
  seconds and retry;
- default maximum is ten retries;
- each physical retry creates a fresh client request ID and fresh Castle token;
- no exponential backoff is added by that adapter;
- success JSON with a truthy `error` is converted into the same error path.

NAB profile behavior:

| Condition | Action | Cursor |
| --- | --- | --- |
| local failure proven to occur before dispatch | no automatic HTTP retry; scheduler may create a later new attempt after its signed cadence | unchanged |
| connection loss/timeout after dispatch | stop in `READ_RESULT_UNKNOWN`; no automatic replay without provider rule | unchanged |
| `Retry-After` on 429/503 | honor as the earliest future scheduler time; no same-operation automatic retry | unchanged |
| 500/502/503/504 without `Retry-After` | stop by default; retry only under provider-approved rule | unchanged |
| 401 or login redirect | stop, `REAUTH_REQUIRED` | unchanged |
| bound-user tombstone, `user_does_not_have_read_permissions`, or bound-budget 403 | stop, `PERMISSION_DENIED` | unchanged |
| `user_does_not_have_family_read_permissions` | clear family view; continue only if bound budget relation remains active | family cursor cleared; budget unchanged |
| other 403 | stop as redacted `PROVIDER_ERROR`; require provider review | unchanged |
| 426 + `client_app_update_required` | stop all auto-sync, `PROTOCOL_UPDATE` | unchanged |
| 400/409/422 or application error | no blind retry | unchanged |
| schema/cursor/type/size failure | quarantine | unchanged |
| `getInitialUserData` ambiguous loss | browser recapture | no session transition |

Private rate limits are unknown, so no private dispatch mode is currently enabled. A future signed
provider contract supplies an application-installation rolling-hour limit, initialization/refresh
burst ceilings, body/cache limits, and a minimum cadence. The browser bridge then schedules no more
often than `max(180 seconds, provider minimum)`, counts each physical dispatch before sending,
coalesces all work, and honors server delay. Pending calls never trigger a sync. There are zero
automatic network retries in this profile: a later scheduler tick is a new operation with a fresh
request/Castle ID and only occurs if the state is not ambiguous. The official public API's
200-token-requests/hour limit is not asserted to govern the private catalog.

## 14. Error model

Transport/application error decoder:

```ts
type PrivateApplicationError = {
  error:
    | string
    | {
        id?: string;
        message?: string;
        data?: JsonValue;
      };
};
```

This is a closed lexical decoder, not a permissive application object. A string error is 1..4,096
UTF-8 bytes and is always unknown/redacted; its text is never interpreted as an ID. An object has
only own properties `id`, `message`, and `data`, no duplicates, and at least one property. `id` and
`message`, when present, are strings of 1..512 and 0..4,096 UTF-8 bytes respectively. `data`, when
present, is any already parser-bounded `JsonValue` whose RFC 8785 JCS is at most 65,536 UTF-8 bytes;
it is never parsed a second time or exposed. An ID is recognized only from the object's exact own
`id` string. Null means no application error. Any boolean, number, array, empty object, unknown
member, wrong type, invalid Unicode, or bound excess is `PROTOCOL_CHANGED`, not an unknown provider
message. Raw strings, messages, and data are destroyed after classification.

Recognized IDs are contextual, using the received integer HTTP status and fixed operation:

| ID | Allowed operation/status context | V1 result |
| --- | --- | --- |
| `server_knowledge_of_device_exceeds_device_knowledge` | `syncCatalogData`, `syncFamilyData`, or `syncBudgetData`; status 200..299 | quarantine/destroy logical device; no merge/cursor advance/retry |
| `user_does_not_have_read_permissions` | `syncCatalogData` or `syncBudgetData`; status 200..299 or 403 | `PERMISSION_DENIED`; no merge/cursor advance |
| `user_does_not_have_family_read_permissions` | `syncFamilyData`; status 200..299 or 403 | clear/disable only the bound family view under section 10.1 |
| `client_app_update_required` | any of the four fixed operations; status 426 | `PROTOCOL_UPDATE` |

A recognized literal in any other operation/status context is a contract contradiction and maps to
`PROTOCOL_CHANGED`; it is not demoted to an unknown error. For a 2xx response, any valid non-null
unknown string/object error is redacted non-retryable `PROVIDER_ERROR`. For non-2xx responses, a
valid object ID is inspected only to recognize one of the four literals and validate its context;
an unknown/string/malformed body is discarded and status mapping wins. A bare 426 never means
update-required.

Known IDs/conditions from current client behavior:

| Condition | Meaning/action |
| --- | --- |
| `server_knowledge_of_device_exceeds_device_knowledge` | device/cursor disagreement; quarantine for this profile |
| `user_does_not_have_read_permissions` | selected budget permission revoked |
| `user_does_not_have_family_read_permissions` | clear/disable family view; do not substitute another family |
| `client_app_update_required` with HTTP 426 | stop auto-sync; protocol review required |
| HTTP 401 | clear session token and require browser reauthentication |
| HTTP status 0 | browser network failure |
| Cloudflare/Heroku HTML/challenge | provider unavailable/security challenge; never bypass |

The complete private error/status table is `UNKNOWN`. Unknown application errors map to a redacted
`PROVIDER_ERROR`, are non-retryable by default, and never advance cursors.

## 15. Version negotiation and compatibility

Four independent signals exist:

1. request `X-YNAB-Api-Version = 2026-01-01`;
2. response `X-YNAB-Server-Version` build metadata;
3. per-document `schema_version` / `schema_version_of_knowledge`;
4. response `schema_version_of_response` and optional `schema_version_of_server`.

There is no verified downgrade negotiation. A conforming client pins the reviewed API header and
all three schemas, requires exact response schema equality, and stops on change. A new optional
field under the same server schema is still rejected unless a newly signed response-shape registry
and closed wire-schema asset classify it. An admitted discarded field may be retained only in the
separately consented diagnostic fixture described in section 3 and MUST never be echoed.

An `X-YNAB-Server-Version` change alone is a compatibility-review signal rather than immediate data
corruption; a schema/API header change is a hard circuit breaker. The current web app schedules a
refresh prompt after it learns of a newer server app version and stops auto-sync on the explicit
426 update-required error.

## 16. Public/private identity joins

The public plan ID, private budget ID, private budget-version ID, entity IDs, `ynab_id`, account
mapping fields, and match IDs are distinct namespaces unless a fixture proves a join.

Rules:

- select private budget version only through the authenticated catalog relation bound to consent;
- keep private entity IDs as opaque local references;
- set public account/transaction IDs to null and `public_get = public_update = false` for every
  `pending-read-v1` result. A provider-defined join would require a new versioned profile;
- public writes require a separate
  public-API command, public identifier, and action-time authorization;
- never fuzzy-match an ID for authority;
- account/date/amount/payee fingerprints may aid display reconciliation only and must surface
  ambiguity;
- a pending→posted association can be one-to-one, changed-ID, disappeared, or ambiguous until
  fixtures/provider contract establish otherwise.

## 17. Normalization algorithm

Given a fully materialized transaction map:

1. Drop tombstones from the active view but retain their sentinels in the device cache. Index every
   active transaction/account/payee/subtransaction by private ID. Validate the source of **every**
   active transaction against the closed enum before considering the operation or any caller
   filter; an unknown source anywhere is `PROTOCOL_CHANGED`.
2. Validate the complete match graph globally under section 8.2. Build each symmetric pair once
   using the raw-UTF-8 ordered private-ID pair. A missing reciprocal, conflicting target, cycle,
   self-link, or multi-target relationship fails the complete query as `PROTOCOL_CHANGED`; a narrow
   filter can never hide graph corruption.
3. Classify every graph-valid row without consulting `accepted`:
   - `raw_pending` → `raw_staging`;
   - `Pending` → `provider_pending`;
   - `ImportedPending` → `entered_provisional`;
   - `matched_pending` → hidden lineage only, never a standalone output;
   - `Matched` with a resolved `matched_pending` counterpart → `matched_provisional`.
   - reciprocal `Matched` with `matched_import` → posted/non-pending;
   - any unresolved live match link → `PROTOCOL_CHANGED`;
4. Authenticate the request's `plan_ref`. For `pending.list`, resolve an optional
   `private_account_ref` before transaction selection by deriving an alias for every active account
   and constant-time comparing all of them: exactly one match yields its raw account ID; zero or
   multiple matches is `WRONG_ACCOUNT_OR_PLAN`. Validate `since_date <= until_date`. `pending.get`
   has neither account nor date filter.
5. Apply lifecycle policy to the visible candidates from step 3: raw staging, provider pending, and
   matched provisional are enabled; entered provisional is enabled iff
   `include_entered_provisional=true`. Then apply operation selection. `pending.get` constant-time
   compares the requested entity alias across enabled visible candidates and selects zero or one;
   zero returns `record:null`, while multiple is `PROTOCOL_CHANGED`. `pending.list` retains a
   candidate only when its raw account ID equals the resolved filter ID if supplied, and its date is
   within each supplied inclusive bound. This order is normative: a disabled lifecycle or a row
   outside the account/date/ref selection is not relationship-projected merely to discover a
   query-time unsupported shape.
6. For every selected visible candidate, expand its required hidden `matched_pending` peer before
   validation. No hidden peer is independently selected or emitted. Resolve the selected row and
   every expanded peer's required
   `entities_account_id` against the complete active account map. A missing or tombstoned target is
   `PROTOCOL_CHANGED`; no alias, account name, filter match, or output record is constructed. For a
   valid pending match the already-required account IDs are equal. The resolved account supplies
   the private-account alias and optional account name.
7. Treat an absent or explicit-null `entities_payee_id` as the same no-payee state under complete-
   replacement semantics. Resolve every present non-null value against the complete active payee
   map; a missing/tombstoned target is `PROTOCOL_CHANGED`. If
   any selected pending-adjacent row or pending-match peer has a non-null `transfer_*` link, a live
   subtransaction, or a resolved active payee whose `entities_account_id` is non-null, fail
   `UNSUPPORTED_PENDING_SHAPE`; version 1 has no transfer/split projection.
8. Normalize the selected visible row only, attach the peer relationship alias when applicable, set
   both public IDs to null and both public capabilities to false, and convert safe-integer money to
   canonical decimal without floating-point scaling. Never emit the hidden peer separately.
9. Deduplicate only by the already-validated visible entity/match-pair identity, sort by date
   descending then private reference ascending, enforce final count/JCS byte ceilings, and require `pending.get`'s selected
   normalization to be byte-identical to the same record in an otherwise equivalent unfiltered
   `pending.list` call with the same lifecycle flag.
10. Emit completeness/freshness metadata and the exact V1 `UNMAPPED_ACCOUNT` warning rule from the
   browser bridge; no mapping lookup occurs.

The normalizer does not calculate budget balances from raw pending entities and does not turn a
pending item into a public write instruction.

Match-graph validation is a merge-time invariant, not a late query preference. If applying a
syntactically valid response would produce any section 8.2 violation, reject the entire candidate,
leave the prior entity cache and cursor unchanged, return `PROTOCOL_CHANGED`, and permanently
quarantine/destroy that logical device; do not serve the prior snapshot as success. By contrast, a
well-formed transfer or live split is valid provider state that Version 1 cannot project: it is
committed/checkpointed normally, and a query selecting that pending-adjacent state returns
`UNSUPPORTED_PENDING_SHAPE`. The fixtures encode this distinction.

## 18. Conformance fixtures

Fixtures MUST be synthetic or irreversibly sanitized and contain no credentials or real financial
text. The checked-in seed corpus and machine-readable expectations are in
[ynab-protocol-fixtures](./ynab-protocol-fixtures/README.md). In that manifest, `phase` is the
furthest boundary asserted: initial decode/identity commit, final pre-transport request guard,
response decode, candidate merge/commit, or normalized query. It is not merely the last boundary
that mutated state. Therefore every golden output and every query-time error is `normalize`,
including a no-change delta whose only commit is `Kr`. Each case also resolves an exact post-state
oracle fixing device state, per-document schema and `Kc`/`Ks`/`Kr`, identity/range metadata, and all
active/tombstone IDs in materialized collections. Required positive fixtures:

1. initial-user-data token replacement;
2. authorized catalog relation at schema 17;
3. family absent and family present at schema 4;
4. budget bootstrap at schema 44, no cursor checkpoint;
5. backfill at zero bounds with `first_month`/`last_month`;
6. no-change delta;
7. delta upsert and tombstone replay;
8. every pending-adjacent source state;
9. symmetric matched pending pair;
10. sparse tombstone;
11. registry-declared discarded optional field/collection under the same schema;
12. fixed null public IDs/capabilities for the version-1 no-join profile.
13. absent and explicit-null transaction payee links producing the same no-payee projection;
14. exhaustive modeled-collection field registry, including a schema-valid provider-attested
    discard-safe field that is validated but absent from normalized output.

Required negative fixtures:

1. empty catalog candidate at schema 17, yielding `PERMISSION_DENIED` because the consent-bound
   relation is absent;
2. nonempty request collection at zero/equal knowledge;
3. `ending > starting` even with empty collections;
4. unknown operation/request field;
5. schema 41 response against schema 44 client;
6. unsafe/noninteger/regressing cursor;
7. invalid amount/date/source/cleared type;
8. duplicate entity ID;
9. broken or asymmetric match;
10. truthy application error in HTTP 200;
11. HTML/login/challenge response;
12. response too large;
13. crash between entity and cursor commits;
14. pending transaction transfer link, payee-only transfer linkage, and live split child, each
    yielding `UNSUPPORTED_PENDING_SHAPE`;
15. unresolved/tombstoned/asymmetric `Matched` or `matched_pending` peer;
16. fraction, exponent, leading-zero, negative-zero, unsafe money/knowledge lexical tokens;
17. user/catalog/family/budget identity mismatch before merge.
18. modeled entity field absent from the signed field registry, field path/schema-pointer mismatch,
    and a discarded field referenced by identity/normalization logic;
19. missing/tombstoned selected account, non-null dangling/tombstoned payee, and payee-account
    transfer linkage. The checked-in non-null dangling-payee seed commits the valid delta, then the
    normalized query returns `PROTOCOL_CHANGED` and the logical device is destroyed.

The checked-in files are deliberately only a seed corpus, not this complete matrix. Named seed gaps
include source `Pending`, source `ImportedPending`, accepted/cleared orthogonality, both sides of the
`include_entered_provisional` opt-in, `pending.get`, account filtering, and inclusive since/until
date filtering (including intersections). A missing seed never weakens the corresponding normative
requirement.

## 19. Live validation boundary

The controlled exercise plan requires three independent proofs of the test budget and strict
request ceilings. The intended minimal mutation sequence is one synthetic transaction create,
one-field update/clear, and tombstone cleanup through normal UI, while passively observing schema
deltas. Private handcrafted writes are never needed.

The repository allowlists an integration-test plan ID, but the final Chrome context was signed out
and no authenticated browser plan or public credential could be bound to it, so no mutation or live
request exercise ran. Non-mutating static/runtime evidence closed the sync-mode,
schema, cursor, request grouping, merge, and pending lifecycle gaps; it did not close provider-only
facts such as private rate limits or pending-ID longevity.

## 20. Provider questions required before implementation

1. May NAB use `/api/v1/catalog`, and for which operations/user population/distribution?
2. Is a dedicated UUIDv4 read-only device with zero outbound knowledge an approved pattern?
3. Which cookies/headers are required, and may Castle tokens be requested for this integration?
4. What are private rate, size, retention, and backfill limits?
5. Is there or can there be a server-enforced read-only scope?
6. What is the private error/status schema and retry guidance?
7. Are pending IDs stable, and what is the authoritative pending→posted linkage?
8. Does one successful backfill guarantee complete retained history?
9. What compatibility window applies to API/schema versions?
10. What logout/revocation mechanism invalidates an exported session?

Without written answers/permission, the technically preferred product path is to request a public
pending endpoint or use an independent bank-data overlay while keeping YNAB writes on the supported
public API.
