# YNAB Protocol Research Provenance

Status: research record; not an official YNAB contract  
Snapshot date: 2026-08-30  
Scope: public API comparison, current web catalog read/sync path, web-client runtime, and pending-transaction lifecycle

This file maps the key empirical claims in the companion specifications to evidence and states the
limits of that mapping: **how do we know this, and how strong is that evidence?** Normative safety
rules are design decisions and need not have a source claim; not every descriptive sentence has a
one-to-one locator. It intentionally contains no
real session values, user/plan/account identifiers, payees, memos, balances, amounts, or transaction
IDs.

## Evidence labels

Claims in this research record are classified with these labels. Companion documents cite this
record at major evidence boundaries; the claim matrix is representative rather than exhaustive.

| Label | Meaning | Can support an implementation? |
| --- | --- | --- |
| `OFFICIAL` | Current provider documentation or platform documentation | Yes, within the documented surface |
| `WEB-STATIC` | Current public YNAB web bundle, identified by path and SHA-256 | Design/schema evidence for those exact bytes only; never provider permission, managed-runtime attestation, or an executable provider contract |
| `WEB-RUNTIME` | Read-only inspection of code and metadata already loaded by the current signed-in web app | Design/schema evidence for that exact historical running document only; never provider permission or a reproducible running-document attestation |
| `WIRE-OBSERVED` | Sanitized request/response shape observed during normal web-app activity | Design/schema evidence for the observed case only; never permission, completeness, or a production dispatch contract |
| `OSS-CORROBORATED` | Independent open-source integration agrees with the finding | Corroboration only |
| `INFERRED` | Best explanation of multiple observations, not directly demonstrated | No; must be guarded or validated |
| `UNKNOWN` | The provider contract or a safe test is missing | No; the implementation must fail closed |

The companion documents define a closed design target where evidence permits and enumerate the
known identified provider/runtime gates rather than silently delegating them to an implementer.
Unobserved facts and newly discovered behavior also fail closed. “Complete” is
not a claim that current private dispatch is implementable, that the seed fixture suite is
exhaustive, or that every server limit/error/future schema is known. A private mode remains disabled
whenever one of those named gates is unresolved.

## Primary evidence inventory

### Official public API

`OFFICIAL-PUBLIC-API-2026-08-30`

- Documentation: <https://api.ynab.com/>
- OpenAPI document: <https://api.ynab.com/papi/open_api_spec.yaml>
- Downloaded SHA-256 on the snapshot date:
  `da7a78345b34b0fa6e50c39709cf860cb869c70d137d506c925d8b1886f3a98b`
- Documentation-page retrieval on the snapshot date: HTTP `200`, decoded body `88,546` bytes,
  SHA-256 `22c788d40b65147e5d1e02ef47c6d317341eb1e8bfa39e8685b90c4a5476748e`.
- Material facts used by this research:
  - base URL `https://api.ynab.com/v1`;
  - bearer-token authentication;
  - REST resources under `/plans/{plan_id}`;
  - public delta cursor `server_knowledge` / `last_knowledge_of_server`;
  - transaction list routes expressly exclude pending transactions;
  - documented transaction filters are `uncategorized` and `unapproved`;
  - public access-token limit is 200 requests in a rolling hour.

The repository's checked-in OpenAPI copy predates the provider's 2026 terminology change from
“budget” to “plan.” The current provider document is authoritative for the comparison; NAB's
existing code still uses its checked-in generated client vocabulary in several places.

### Official provider terms

`OFFICIAL-API-TERMS-2026-08-30`

- Retrieval URL: <https://api.ynab.com/>
- Retrieval date/status/body identity: 2026-08-30, HTTP `200`, decoded body `88,546` bytes,
  SHA-256 `22c788d40b65147e5d1e02ef47c6d317341eb1e8bfa39e8685b90c4a5476748e`.
- Exact relevant headings/numbered clauses in the embedded **API Terms of Service**:
  `Authorized Use`, `Security and Permitted Access`, `API Limitations`, and
  `Illegal and Restricted Use`.
- Exact relevant OAuth policy location: policy item 5(4), under the OAuth application requirements,
  says undocumented APIs require express written permission. The page labels that policy
  `Last updated: May 28, 2025`.

`OFFICIAL-GENERAL-TERMS-2026-08-30`

- Retrieval URL: <https://www.ynab.com/terms>
- Page label: `Last Modified: April 9, 2026`.
- Retrieval date/status/body identity: 2026-08-30, HTTP `200`, decoded body `141,916` bytes,
  SHA-256 `db955c14e215f3d4ecfc27afcf1a79e50025f604cda923d363a2c1fb443de270`;
  response `Last-Modified: Sat, 29 Aug 2026 13:42:53 GMT`.
- Exact relevant headings/locations: `Intellectual Property Rights` contains the reverse-engineering
  restriction; `Prohibited Uses` contains the robot/bot/spider/scraper/offline-reader restriction,
  the manual-monitoring/copying restriction absent prior written consent, and the suspension/
  termination statement.

The release gate derived from these sources is an engineering/product-risk decision, not legal
advice or a claim that every conceivable personal experiment has the same legal characterization.
User consent does not itself establish provider permission.

### Current YNAB web assets

The signed-in page loaded these same-origin assets. They were fetched separately as public static
files for source-level inspection; no authenticated request headers or cookies were used to fetch
the files.

Retrieval base: `https://app.ynab.com`; retrieval date: 2026-08-30. All three responses were HTTP
`200` with no authenticated request headers or cookies.

| Evidence ID | Public asset path | Decoded bytes | SHA-256 | Response `Last-Modified` |
| --- | --- | ---: | --- | --- |
| `WEB-ASSET-A` | `/assets/ynab_web/assets/chunk.f944a7a90eac745631dd.js` | 8,203,386 | `80575f977b70f4f6b62ee014d28282fd162219a75b05ca01a7607c8e366499eb` | `Thu, 27 Aug 2026 02:39:04 GMT` |
| `WEB-ASSET-B` | `/assets/ynab_web/assets/chunk.487853630c5218864caf.js` | 3,021,490 | `b0f34336cdcf76f32638081a9022e833568c241f52b78d85b1098865694f3f94` | `Thu, 27 Aug 2026 02:39:04 GMT` |
| `WEB-ASSET-VENDOR` | `/assets/ynab_web/assets/vendor.415646efd44903cb1190197118751ba1.js` | 94,922 | `3c8fde681a1f714e78e2f62201f3e2223542c8b261f524d26818f59dbab8e759` | `Mon, 10 Aug 2026 18:44:00 GMT` |

The asset filenames are content/build identifiers, not a promise that the files will remain
available. The bundles are not checked into this repository. Consequently a path/hash/length proves
identity only after an independent researcher reacquires the same bytes; it does not reconstruct
missing bytes and is not a permanent reproducibility guarantee. The research records method
behavior and short identifiers, not copied bundles.

`WEB-ASSET-B` supplied the strongest current evidence for:

- API adapter transport, headers, response handling, and `Retry-After` behavior;
- the complete V1 catalog operation registry used by the shared library;
- schema versions and the `bootstrap | backfill | delta` enum;
- `SyncManager`, store, knowledge object, entity manager, and merge behavior;
- all current catalog/family/budget entity converters;
- transaction source constants and pending/import matching transitions.

Conditional textual locators inside `WEB-ASSET-B` include
`sendCatalogRequest`, `hasChangedEntities`, `syncBudgetDataWithServer`,
`internalSyncBudgetDataWithServer`, `syncBudgetDataBackfill`,
`possiblyImportTransactionsAfterBudgetSync`, and the literal source strings `raw_pending`,
`Pending`, `ImportedPending`, `Matched`, `matched_import`, and `matched_pending`. Search those exact
tokens in the independently reacquired, hash-matching bytes. No stable source map, byte offsets, or
snippet corpus was retained, so these locators are not independently reproducible if the CDN stops
serving the exact asset.
The runtime reference groups the resulting observations by API adapter, store/sync flow, converter
registry, and pending state machine.

### Signed shared-core archaeology

The companion [static-analysis appendix](./YNAB_SHARED_LIBRARY_STATIC_ANALYSIS.md) independently
analyzes a signature-verified YNAB Android artifact plus commit-pinned public repositories. It
provides a broad sync-relevant shared-core/entity-manager surface, mobile persistence ordering, converter
field lists, and additional pending mutation dependencies without using a browser session.

That artifact uses catalog schema `16`, budget schema `44`, and family schema `4`, and it has no web
`SyncManager`. Those differences are evidence of platform/version drift. For current web transport,
schema, and orchestration, this provenance record and
[YNAB_WEB_CLIENT_RUNTIME.md](./YNAB_WEB_CLIENT_RUNTIME.md) take precedence.

### Current running web library

`WEB-RUNTIME-2026-08-30`

Non-mutating object-key/method inspection of the loaded page confirmed the reviewed build exposes
`window.ynab.YNABSharedLib.defaultInstance` and the following major components:

- API adapter with V1 catalog, V2 REST-like, and token-authenticated online layers;
- entity, display-entity, change-set, formatting, portation, transition-map, view-model, sync, and
  store managers;
- catalog, family, budget-source, and budget-calculation collection registries;
- exported transaction source/state/display enums.

Sanitized current values:

| Property | Value |
| --- | --- |
| Catalog schema | `17` |
| Budget schema | `44` |
| Family schema | `4` |
| Catalog API version header | `2026-01-01` |
| Two-step initial sync | enabled |
| Automatic sync | enabled |
| Current app-configured heartbeat | 180,000 ms |
| V1 token-auth mode | disabled |

Inspection was limited to own-property names, function names/arities, constant values, schema/app
configuration, and method source text already present in the page. No method that synchronizes or
mutates was invoked, and no collection contents or financial values are part of this evidence
record. The build identity is the exact asset hash set above; no claim is made across later builds.

### Sanitized wire observation

`WIRE-OBSERVED-INITIAL-SYNC`

Normal web-app initialization previously showed this order:

1. `getInitialUserData`
2. `syncCatalogData`
3. `syncFamilyData`
4. `syncBudgetData` with `sync_type = "bootstrap"`
5. `syncBudgetData` with `sync_type = "backfill"`

It also established the form transport, common knowledge fields, response envelope, and presence of
the custom session/device/version headers. Static code now independently corroborates each
operation wrapper and the two-step budget flow.

No retained sanitized wire artifact, capture hash, or reproducible run identifier exists for this
historical observation. Treat `WIRE-OBSERVED-INITIAL-SYNC` as non-reproducible research testimony;
it cannot independently satisfy a conformance requirement. Only claims separately corroborated by
the hashed static assets are used normatively without a new sanitized capture.

### Open-source corroboration

`OSS-TOOLKIT-DA9022C`

- Project: Toolkit for YNAB
- Pin: <https://github.com/toolkit-for-ynab/toolkit-for-ynab/tree/da9022ccdb203bebf005eba4b2010111b52c76e4>
- Relevant evidence: the page-global entity manager integration, transaction type, pending display
  item, and source constants.

This source is useful independent corroboration, not a YNAB contract. Any OpenTabs evidence used in
the final protocol is recorded with an exact commit in the source matrix below rather than cited as
provider documentation.

### Official Chrome platform contracts

These sources define what a proposed Chrome extension/native host can do. They do not authorize
YNAB access, prove that a YNAB session is replayable, or attest a concrete extension/runtime build.
Raw HTML hashes identify the retrieved pages on 2026-08-30 and may change for editorial reasons.

| Evidence ID | Official URL | HTTP/decoded bytes/SHA-256 | Facts used |
| --- | --- | --- | --- |
| `OFFICIAL-CHROME-COOKIES-2026-08-30` | <https://developer.chrome.com/docs/extensions/reference/api/cookies> | `200`; 191,100; `89ee68137b707871530c7ed1e12a19f153c6496d45afb36a4b2ad5c8ee9a3b26` | `cookies` plus host permission; cookie value and HttpOnly/store/session/domain/path/SameSite/Secure/partition metadata; unpartitioned default; overwrite emits remove then add |
| `OFFICIAL-CHROME-NATIVE-MESSAGING-2026-08-30` | <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging> | `200`; 149,287; `74169ccd175788a435f50838be2a3046568be2ca015d4613c72d2398f6949567` | UTF-8 JSON prefixed by native-endian 32-bit length; 1 MiB host-to-Chrome and 64 MiB Chrome-to-host limits; caller extension origin is argv[1]; one process per connected port; API unavailable directly to content scripts |
| `OFFICIAL-CHROME-WEBNAVIGATION-2026-08-30` | <https://developer.chrome.com/docs/extensions/reference/api/webNavigation> | `200`; 239,403; `b20fb41f28681ce81b5234fd7f3f82501b4ab6ab0945a84bbe3997bee1db23a2` | `documentId` changes with a new document; `getFrame` can validate document/tab/frame association; lifecycle is reported on navigation events |

`OFFICIAL-CHROMIUM-COOKIE-PERMISSION-FILTER-2026-08-30` pins Chromium commit
[`faf0601ad0d8dc5cbf5b94d07e3b43debc512a5b`](https://chromium.googlesource.com/chromium/src/+/faf0601ad0d8dc5cbf5b94d07e3b43debc512a5b/).
At that commit,
[`cookies_helpers.cc`](https://chromium.googlesource.com/chromium/src/+/faf0601ad0d8dc5cbf5b94d07e3b43debc512a5b/chrome/browser/extensions/api/cookies/cookies_helpers.cc)
is 18,767 decoded bytes with SHA-256
`4a1e4c0b0629388dd7f1fd8e8468ebfd5b13598c6982ddf119b7dfb554d63521`, and
[`cookies_helpers.h`](https://chromium.googlesource.com/chromium/src/+/faf0601ad0d8dc5cbf5b94d07e3b43debc512a5b/chrome/browser/extensions/api/cookies/cookies_helpers.h)
is 7,991 decoded bytes with SHA-256
`45f8fe8b04b140dc771688c4aa20233cc923408edbc2b4f64ddc9439d5f8f7a8`.
The implementation filters each cookie through page access for a URL derived from that cookie; the
header states that Secure selects the URL scheme and the cookie domain becomes its host. This is
why the capture design cannot infer completeness from an HTTPS app-subdomain permission when a
required cookie might be non-Secure or parent-domain scoped.

## Claim-to-evidence matrix

| Claim | Evidence | Confidence |
| --- | --- | --- |
| Public transaction lists omit pending records | Current official OpenAPI | `OFFICIAL` |
| Web sync uses `POST /api/v1/catalog` with `operation_name` and JSON-string `request_data` form fields | V1 adapter plus wire observation | `WEB-STATIC`, `WIRE-OBSERVED` |
| Routine budget refresh is `sync_type = "delta"` | Current enum, `SyncManager.syncData`, store default | `WEB-STATIC`, `WEB-RUNTIME` |
| Backfill zeros both outbound device-knowledge bounds | `internalSyncBudgetDataWithServer` | `WEB-STATIC` |
| Bootstrap does not persist server knowledge; backfill/delta do | store response path | `WEB-STATIC` |
| A read-only request is defined by `ending_device_knowledge <= starting_device_knowledge` in the official web client's guard | V1 `hasChangedEntities` and read-only guard | `WEB-STATIC` |
| Current web page creates a new UUIDv4 device ID during store initialization | web store initializer and UUID module | `WEB-STATIC` |
| Server entities merge as full converter objects and reset entity `deviceKnowledge` to zero | entity manager and converter registry | `WEB-STATIC`, `WEB-RUNTIME` |
| Request-side transaction and scheduled-transaction changes are grouped; response-side collections are flat | store serializer and response merge registry | `WEB-STATIC` |
| Raw pending becomes `Pending`; matching code can use `matched_pending`; approval can retain `ImportedPending` while Direct Import remains active (otherwise source may become null). Exact winner/loser wire permutations remain unverified. | import, editor, and matching modules | `WEB-STATIC`, `OSS-CORROBORATED`; representation `UNKNOWN` |
| Raw pending IDs remain stable through settlement | No safe evidence | `UNKNOWN` |
| A copied Castle token supports durable native replay | No safe evidence | `UNKNOWN` |
| Private rate limits equal public API limits | No evidence | `UNKNOWN` |
| Chrome can return cookie values/metadata only with the cookies API and matching host permission | Official Chrome cookies contract | `OFFICIAL` |
| Cookie API results are additionally page-access filtered using a cookie-derived URL whose host is the cookie domain and whose scheme follows Secure | Pinned Chromium cookies helper source/header | `OFFICIAL` source implementation for the pinned commit |
| Native Messaging framing and per-direction limits are fixed as specified in the bridge | Official Chrome Native Messaging contract | `OFFICIAL` |
| A Chrome `documentId` is a document-lifetime binding, not a stable tab identity | Official Chrome webNavigation contract | `OFFICIAL` |
| Undocumented-API use is releasable without provider permission | Current YNAB API/OAuth policy says the opposite | `OFFICIAL`; release remains disabled |

## Research safety boundary

The live inspection rules were:

- no cookie, local-storage, password-store, Chrome-profile database, or session-store inspection;
- no raw token/header values in output;
- no real user, plan, account, category, payee, transaction, amount, balance, or memo values;
- code and object-key inspection only on the ordinary plan;
- no live write unless the test plan is identified by the three-factor proof in
  [YNAB_SYNC_TEST_BUDGET_VALIDATION_PLAN.md](./YNAB_SYNC_TEST_BUDGET_VALIDATION_PLAN.md);
- no handcrafted catalog write in any plan;
- low request volume and no attempts to evade anti-abuse controls.

The repository's `AGENTS.md` allowlists one integration-test plan ID. At the final Chrome check the
selected YNAB context showed sign-in, no authenticated plan could be matched to that allowlist, and
the research process had no public test credential in its environment. Therefore **no mutation
exercise was performed**. This is an evidence gap, not permission to test against another plan.

## Unresolved provider-contract questions

These are not silently filled with guesses in the companion specifications:

1. Which cookie names are strictly required, how they rotate, and how server-side logout revokes
   copied sessions.
2. Castle request-token lifetime, binding, renewal, and whether native replay is an intended use.
3. Official private-catalog rate limits and maximum request/response sizes.
4. The complete server-side error ID/status matrix.
5. Whether unknown schema versions can be negotiated rather than rejected.
6. Historical backfill completeness/retention rules and whether it can require multiple calls.
7. Stability of pending entity IDs through provider refresh, adjustment, disappearance, matching,
   and posting.
8. Whether the current UUIDv4 device behavior is an authorized standalone-device registration
   contract.
9. Private mutation conflict resolution under simultaneous editors; this is outside the
   `pending-read-v1` profile and deliberately untested.
10. A provider-supported, server-enforced read-only scope for catalog sync; none was observed.

## Mode-by-mode executable-contract gates

The facts above are not interchangeable with a runnable adapter. A mode is enabled only if every
row for that mode is supplied by a signed provider policy, a pinned executable asset, or a live
attestation exactly as required by the bridge specification. A newly discovered dependency that is
not in the signed contract is itself a disabling protocol change.

| Mode | Required provider/runtime facts still missing on 2026-08-30 |
| --- | --- |
| `page-snapshot` | Written permission; provider-managed extension/runtime attestation; running-document build hash; executable accessor and payload schemas; passive complete-success/freshness signal; exact account/payee/transfer/split and matched-peer representation; bounded response/retention contract |
| `browser-catalog` | Written permission; managed execution-realm/session/token-channel attestation; device and Castle generation/rotation/binding rules; required-header and cookie behavior; exact signed response-shape/field-disposition registry; operation/status/application-error table; rate/size/backfill/retention limits; logout/revocation behavior; matched-peer representation |
| V1 `native-replay` capture research | Written permission; dedicated managed profile and build attestation; exact capture eligibility/quiescence facts; executable proof that all required catalog cookies are Secure and app-subdomain scoped; token/Castle rotation semantics; provider logout/revocation proof. Even if supplied, Version 1 validates and erases one staged seed and cannot dispatch or return pending records |
| Future V2 native replay | A new versioned protocol plus every browser-catalog fact, a complete stateful cookie/token/Castle channel, TLS/redirect/challenge behavior, ambiguity-free two-phase credential rotation, server-device authorization, and effective revocation |

This table is a known-gate inventory, not proof that no additional provider dependency exists.

## Updating this record

A future protocol refresh must:

1. record the observation date, asset paths, hashes, and all three schema versions;
2. diff the operation registry, converter field registry, source enum, and sync state machine;
3. update sanitized fixtures without retaining personal data or credentials;
4. rerun the conformance and redaction suites;
5. require human review before accepting any changed field type, cursor rule, auth header, or
   operation classification;
6. re-check provider terms and written permission.
