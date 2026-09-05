# YNAB Pending Transactions: Executive Report and Specification Index

Status: research/design record; not an official or authorized YNAB API  
Snapshot: 2026-08-30  
Observed web versions: API `2026-01-01`; catalog `17`; family `4`; budget `44`

This is the executive report for NAB's pending-transaction research. Exact transport, runtime,
browser, evidence, and validation contracts live in the companion specifications linked below.

## Executive answer

The public YNAB API and the web app fetch different representations. The public API is a documented
bearer-authenticated REST API. Its plan, account, category, payee, and month transaction-list routes
expressly exclude pending transactions. `type=unapproved`, `type=uncategorized`, and
`last_knowledge_of_server` operate only inside that already-filtered posted resource set.

The web app uses a private replication endpoint:

```http
POST https://app.ynab.com/api/v1/catalog
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

operation_name=syncBudgetData&
request_data=<percent-encoded JSON>
```

This is not a hidden “get pending” REST route. It synchronizes an entity graph through independent
catalog, family, and budget documents with device/server knowledge counters. Pending is lifecycle
state inside `be_transactions`:

| Source | Meaning | NAB default |
| --- | --- | --- |
| `raw_pending` | hidden provider staging before the normal client transforms it | include as raw staging |
| `Pending` | visible provider-pending row; no plan/balance effect | include |
| `ImportedPending` | entered provisional register row; has plan effect | opt-in |
| `Matched` with reciprocal `matched_pending` peer | proposed visible side of a pending match | include once only after runtime/provider confirmation |
| `matched_pending` | possible hidden match side | lineage only under the same confirmation; never double count |

`accepted` and `cleared` are orthogonal. A reader requiring `accepted === false` is incorrect.
A catalog reader that sends no financial/entity mutations must recognize `raw_pending` because
YNAB's current web client performs the `raw_pending -> Pending` transformation client-side and
skips that mutating import pass in its library read-only mode.

No documented public query flag can coerce those records into transaction-list responses. Two
public read edge cases remain empirically untested:

1. `GET /plans/{plan_id}` is called a full plan export and has a transactions array, but that
   property does not separately restate the list-route pending exclusion.
2. `GET /plans/{plan_id}/transactions/{transaction_id}` has no pending model, requires a public ID,
   and private pending IDs are not established as public IDs.

Neither is a supported pending-query design. `POST /plans/{plan_id}/transactions/import` initiates
import of available transactions; it does not list pending bank authorizations.

## Recommended paths

In priority order:

1. Ask YNAB for a public pending endpoint or `include_pending` expansion with a documented
   lifecycle, stable posted linkage, OAuth scope, delta cursor, and rate limit.
2. With YNAB's approval and a build-pinned passive completeness signal, use a browser-resident page
   snapshot returning only normalized records.
3. If raw-stage completeness is required, ask YNAB to designate a same-origin browser realm,
   session/Castle contract, and limits for an isolated zero-change logical device.
4. Use an independent bank-data overlay and keep every YNAB mutation on the public API.
5. Retain one-shot cookie/session capture only as explicitly authorized, capture-validation research;
   actual replay would require a separate Version 2 contract.

Reading or decrypting Chrome profile databases is rejected.

| Design | Credentials | Completeness | Stability | Decision |
| --- | --- | --- | --- | --- |
| Public YNAB endpoint | PAT/OAuth | provider-defined | supported | target |
| Bank overlay | no YNAB web session | bank-provider dependent | supported externally | viable fallback |
| Page snapshot | remain in Chrome | hydrated current page | page-model dependent | blocked: no executable build/accessor/passive-completeness/matched-shape contract |
| Browser catalog | remain in Chrome | would include raw staging | schema/sync dependent | blocked: no provider realm, session/Castle/token-channel/response-shape contract |
| V1 native capture research | one seed staged, validated, then erased | no pending result | one-shot only | permanently dispatch-disabled in V1 |
| Future V2 native replay | exported full web session | potentially raw-stage; unspecified | Castle/session fragile | not specified; requires provider-approved V2 |
| Profile DB scraping | broadly exposed | broad | highly fragile | no-go |

Every private row also requires written YNAB permission, the dedicated NAB profile, provider-managed
runtime package attestation, running-document build attestation, exact executable adapter/schema
assets, identity binding, and the signed rate/error/retention contract. None of those global gates is
satisfied by an ordinary logged-in Chrome tab or user consent alone.

Accordingly, there is no deployable/conforming private mode under current evidence. The normative
documents below specify what would have to become true; they are not evidence that any private mode
is presently authorized or operational.

## Public versus web protocol

| Dimension | Public API | Web catalog |
| --- | --- | --- |
| Base | `https://api.ynab.com/v1` | `https://app.ynab.com/api/v1/catalog` |
| Auth | `Authorization: Bearer` PAT/OAuth | browser session, `X-Session-Token`, device/Castle/version headers |
| Style | REST resources, JSON | operation-multiplexed form POST |
| Plan identity | `plan_id` | catalog relation selecting `budget_version_id` |
| Delta | `server_knowledge` / `last_knowledge_of_server` | `Kc`, `Ks`, and `Kr` |
| Writes | explicit POST/PATCH/DELETE | nonempty bidirectional `changed_entities` interval |
| Pending | excluded from list routes | transaction source lifecycle |
| Stability | documented | private, web-build coupled |

Current public OpenAPI is `1.86.0`. Transaction-list parameters are `since_date`, `until_date`,
`type` (`uncategorized` or `unapproved`), and `last_knowledge_of_server`. Responses contain
`transactions[]` and `server_knowledge`. That cursor is a server delta cursor, not pagination and
not a resource-expansion mechanism. Since API 1.85.0, omitting `since_date` defaults list routes to
one year ago; callers must pass it explicitly for older posted history. This still does not expose
pending entities. Public transaction state has `approved` and cleared status, but
no equivalent of the private pending source enum. Scheduled transactions are future/recurring
instructions, not bank authorizations. The documented public-token limit is 200 requests per
rolling hour; it says nothing about catalog limits.

## Current web-client flow

```text
page meta session token
  -> getInitialUserData({device_info})
  -> replace session token from response
  -> syncCatalogData
  -> syncFamilyData when applicable
  -> syncBudgetData("bootstrap") and await
  -> syncBudgetData("backfill") asynchronously
  -> routine syncBudgetData("delta")
```

The runtime exposes `window.ynab.YNABSharedLib.defaultInstance` with API, store, sync, entity,
display, change-set, transition, view-model, formatting, and import/export managers. The
shared-library heartbeat default is 60 seconds; the web app overrides it to 180 seconds. A refresh
serializes catalog/family before budget and coalesces callers onto one worker.

The web build creates a fresh UUIDv4 device ID and keeps entity state and cursors in memory; its
knowledge/local-storage persistence hooks are no-ops. Current headers include a fresh client request
UUID, API version, device ID, session token, truthful device/app metadata when configured, and a
fresh Castle request token when Castle is configured. Same-origin cookies are ambient. The current
V1 adapter does not use bearer authorization. Cookie-only, header-only, and Castle lifetime/binding
behavior remain unknown.

## Replication and merge contract

Each document owns:

```text
Kc = currentDeviceKnowledge
Ks = serverKnowledgeOfDevice
Kr = deviceKnowledgeOfServer
```

A local change advances `Kc` and stamps its entity. Normal writable sync sends `(Ks, Kc]`:

```text
starting_device_knowledge  = Ks
ending_device_knowledge    = Kc
device_knowledge_of_server = Kr
changed_entities           = entities whose knowledge is greater than Ks
```

NAB's bounded zero-change profile is stricter than YNAB's built-in read-only guard. A fresh
independent device
must serialize start/end zero and an exactly empty change set, rejecting unknown request fields.

Budget modes are a closed enum:

- `bootstrap` materializes a usable current view but does not checkpoint `Kr`;
- `backfill` forces zero start/end, performs one observed history merge, and checkpoints `Kr`;
- `delta` requests changes after `Kr`.

No continuation token or current-client backfill loop was found; that is not a provider guarantee
of unlimited history. Incoming `changed_entities` is a delta bag. An absent collection means no
changes. A present entity is a complete converter input/replacement for that identity, not a JSON
field patch. Tombstones stay in the identity map. Entities must be atomically published with `Kr`.
Persistent clients require durable entity-before-cursor commits; the Version 1 browser epoch may
use one in-memory map/cursor swap only because its UUID, map, and cursor are discarded together and
never survive a worker/port loss.

Transaction writes—which `pending-read-v1` forbids—use groups:

```text
be_transaction_groups[] =
  { id, be_transaction, be_subtransactions[] }
```

Responses flatten them into `be_transactions[]` and `be_subtransactions[]`. Scheduled transactions
have the same asymmetry. Calculation collections and several Direct Import/user fields are
response-only. The runtime reference inventories the reviewed-build collections and converter-read
fields; it does not claim a complete server-required wire schema.

## Pending matching and settlement

Normal client ingestion:

```text
raw_pending
  -> Pending + Uncleared
  -> payee/category resolution
  -> optional matching
  -> later delta uploads the client-side transformation
```

A pending match appears symmetric in the analyzed client paths, but the exact winner/loser wire
representation across permutations is not yet runtime/provider-confirmed. The proposed V1 subset is:

```text
visible/user side: source Matched          -> hidden peer
hidden/import side: source matched_pending -> visible peer
```

Accepting the pair normally retains one visible row, copies imported metadata/`ynab_id`, changes
the retained source to `ImportedPending`, and tombstones the hidden side. A later cleared import can
move `Pending` or `ImportedPending` to `Imported`. Current matching uses equal amount and a ten-day
window for an allowlisted source-pair matrix, with further transfer/internal-payee exclusions.

`matched_transaction_id` is a private peer link. `ynab_id` is import metadata. Neither is proven to
be a public transaction ID. Private pending IDs may change or disappear on settlement. Fuzzy
account/date/amount/payee matching can aid display only; it must never authorize a public write.

## Cookie-grabbing design

A cookie alone is not a usable direct-sync session. A handoff may need:

- applicable cookies with domain/path/host-only/Secure/SameSite/expiry/store/partition metadata;
- rotating `X-Session-Token`;
- a client-owned device UUID and independent cursors;
- current API/app/device metadata;
- a fresh client request UUID per attempt;
- a fresh Castle token per request.

The least-dangerous *future authorized* capture shape is a dedicated YNAB-only Chrome profile plus a
Manifest V3 extension. A closed popup-to-worker ceremony would synchronously request exact-origin
`cookies`/`webRequest` permission, while preinstalled permission observers and a sentinel-first
catalog observer set make prompt, navigation, overlap, and crash races explicit. Three phase-bound
cookie snapshots would be authenticated around one naturally generated post-bootstrap request,
then a nonce-bound seed would cross Native Messaging solely for validate-and-erase. The provider
would have to certify that every required catalog cookie is Secure and scoped no wider than
`app.ynab.com`; Chrome's host-permission filtering otherwise makes completeness unprovable. Current
Version 1 stores nothing and MUST NOT dispatch a captured seed: no executable cookie-scope,
passive-success, Castle/native-device, quiescence, or provider-authorization contract is verified.

The extension must not expose `cookie.get`, arbitrary `catalog.call`, `http.fetch`, headers, or
JavaScript evaluation. If a later provider-authorized version persists a session, its native helper
would need a standards-compliant cookie jar, atomic `Set-Cookie` handling, a fully specified
encrypted OS-credential-store record, and fail-closed session/Castle/challenge/schema behavior.

Native replay may still require Chrome for every Castle token and locally enforced read-only mode
does not make the bearer-equivalent web session server-read-only. It therefore remains
developer-only. The browser-bridge spec defines the current extension/consent/normalized-JSON/IPC,
ephemeral-secret, ambiguity, logging, and revocation boundaries and explicitly gates any future
persistent native credential format or rotation mechanism on a new provider-authorized version.

## NAB extension seam

Pending should be a separate `PendingTransactionSource`, not an extension of NAB's public
`YnabClient`:

```ts
interface PendingTransactionSource {
  status(): Promise<PendingSourceStatus>;
  list(query: PendingQuery): Promise<PendingListResult>;
  get(privateEntityRef: string): Promise<PendingTransaction | null>;
}
```

Suggested commands:

```text
nab tx pending status
nab tx pending list [--account ...] [--since ...] [--until ...]
nab tx pending get <private-ref>
nab web connect
nab web disconnect
```

PAT/OAuth and browser auth remain separate. Private references are namespaced and rejected by public
mutation commands. Amounts cross process boundaries as canonical milliunit strings.
`raw_pending` and `Pending` are default results. The proposed visible `Matched` plus reciprocal
`matched_pending` normalization becomes a default only after its pinned-runtime/provider shape gate
passes; until then any match-adjacent state fails closed. `ImportedPending` is opt-in; a confirmed
hidden `matched_pending` is lineage only. Private paths send no
financial/entity mutations, although session/device bookkeeping may occur in a future authorized
catalog mode. Payee/memo text is untrusted data, never agent instructions.

Any future pending write feature requires a provider-supported operation, explicit preconditions,
preview/confirmation, action-time identity checks, idempotency, a separate journal resource, and
documented reversibility. Private client methods are not authority for that design.

## Completeness boundary

The companion `pending-read-v1` contract is a closed normative design target for the deliberately
bounded reader: transport, closed operations, schemas, cursor transitions, merge/deletion,
concurrency, retry/error policy, crash consistency, version circuit breakers, normalization, and
fail-closed behavior are specified wherever evidence permits. Unknown provider facts are represented
as mandatory gates rather than implementation choices. Its checked-in JSON is a seed corpus plus
closed normalized-output schemas, not proof of server behavior or a finished executable test suite.
Provider/runtime gates below mean the target is not currently deployable.

Only YNAB can complete these provider facts:

- required cookies/headers and session/Castle/device binding;
- a provider-managed execution realm and cryptographic running browser/extension/build attestation;
- executable page accessor, passive completeness/freshness, catalog response-shape, per-field
  disposition, and matched-pending representation assets for each permitted build;
- private rate/size limits;
- server atomicity, deduplication, and cursor-divergence recovery;
- backfill retention/completeness;
- complete operation/status/error-ID behavior and retry guidance;
- pending-ID and pending-to-posted guarantees;
- schema compatibility windows;
- a server-enforced read-only scope;
- a logout/session-revocation contract, including what invalidates any copied browser session;
- permitted use and maintenance commitments.

Those remain explicit provider questions, not guesses derived from malformed or high-load tests.

## Provider proposal

The smallest supported contract NAB should request is:

```text
GET /v1/plans/{plan_id}/pending_transactions
Authorization: Bearer <OAuth/PAT>
```

It should return stable pending/account identity, authorization and update dates, signed milliunit
amount/currency, raw and cleansed merchant, pending/entered/matched/posted/voided/expired status,
provisional indicators, posted transaction linkage, delta tombstones, and `server_knowledge`.
YNAB should define pagination, retention, duplicate presentments, partial captures/tips,
amount/date changes, disappearing authorizations, OAuth scope, rate limits, and webhook behavior.

## Policy, validation, and release gate

Current YNAB API terms require express written permission for undocumented APIs and prohibit
circumventing API limitations. Current general terms also prohibit reverse engineering and
automated access such as bots/scrapers. User consent does not replace provider permission.
Therefore a distributed private-catalog feature is a no-go without written authorization, and raw
cookie export should not ship as a production agent capability. This is an engineering/product risk
assessment, not legal advice.

Research used current official docs/OpenAPI, hashed public web assets, non-mutating runtime
method/object inspection, sanitized passive request-order observations, and pinned open-source
corroboration. It did not inspect browser cookies/databases, passwords, local storage, session
stores, or raw financial records.

The repository allowlists one integration-test plan ID, but at the final Chrome check the selected
YNAB context showed the sign-in page and no authenticated plan could be matched to that allowlist.
No public test credential was present in the process environment either. The live context therefore
could not satisfy the validation plan's complete binding check, so no create/update/delete
exercise, pending mutation, handcrafted private request, or replay occurred. Server validation and
live identity-continuity claims remain unresolved.

## Specification set

- [Normative catalog protocol](./YNAB_CATALOG_PROTOCOL.md): the bounded `pending-read-v1` design
  target—transport, types, operations, cursors, state machine, errors, versions, normalization, and
  conformance requirements.
- [Web client runtime](./YNAB_WEB_CLIENT_RUNTIME.md): exact managers/methods, call graph,
  collection/field registry, serializers, converters, merge logic, and pending transitions.
- [Shared-library static appendix](./YNAB_SHARED_LIBRARY_STATIC_ANALYSIS.md): signed mobile-core
  archaeology, broad sync-relevant EntityManager surface, persistence ordering, recovered field registries, and
  version-drift evidence. Current web values in the runtime reference take precedence.
- [Browser/cookie bridge](./NAB_BROWSER_BRIDGE_PROTOCOL.md): Chrome permissions, consent, three
  execution modes, normalized API, IPC, credentials, redaction, and revocation.
- [Provenance](./YNAB_PROTOCOL_PROVENANCE.md): hashes, confidence labels, claim/evidence matrix,
  safety boundary, and provider-only gaps.
- [Test-budget validation plan](./YNAB_SYNC_TEST_BUDGET_VALIDATION_PLAN.md): identity proof, minimal
  UI sequence, request ceiling, sanitization, cleanup, and stop conditions.
- [Protocol fixture corpus](./ynab-protocol-fixtures/README.md): 19 synthetic request/response
  cases, exact post-state oracles, normalized-output schemas, and negative guard vectors.

When files differ, the normative profile controls hypothetical client behavior; the runtime
reference describes YNAB's current implementation; provenance controls confidence.

## Primary references

- YNAB API and API terms: <https://api.ynab.com/>
- Current OpenAPI: <https://api.ynab.com/papi/open_api_spec.yaml>
- YNAB terms: <https://www.ynab.com/terms>
- Chrome cookies: <https://developer.chrome.com/docs/extensions/reference/api/cookies>
- Chromium cookie permission filtering (pinned):
  <https://chromium.googlesource.com/chromium/src/+/faf0601ad0d8dc5cbf5b94d07e3b43debc512a5b/chrome/browser/extensions/api/cookies/cookies_helpers.cc>
- Chrome Native Messaging: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Chrome extension security: <https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure>
- Toolkit for YNAB pin:
  <https://github.com/toolkit-for-ynab/toolkit-for-ynab/tree/da9022ccdb203bebf005eba4b2010111b52c76e4>
