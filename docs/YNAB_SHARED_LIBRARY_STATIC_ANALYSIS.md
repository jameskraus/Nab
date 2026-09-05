# YNAB shared-library and sync protocol: static-analysis appendix

Status: research artifact, not an implementation contract

Analysis date: 2026-08-30

Scope: public/static artifacts only; no browser session, cookies, account, or budget was accessed

This appendix reverse-maps the client-side object model and document-sync machinery that surrounds YNAB's private `syncBudgetData` protocol. It is deliberately stricter about provenance than a normal reverse-engineering note: a statement observed in YNAB's current Android shared-library bundle is not silently promoted to a statement about the current web client, and a third-party integration's successful behavior is not treated as a server guarantee.

It complements the runtime-oriented protocol documents in this repository. The purpose here is to answer four questions:

1. What reusable library, manager, entity, and persistence abstractions exist?
2. How does that code construct and apply catalog/family/budget sync operations?
3. What is directly known about pending-transaction representation and lifecycle?
4. Which details still require a controlled runtime trace before an independent client can be considered correct?

## 1. Evidence vocabulary

Every material claim uses one of these labels:

- **O-M — observed, mobile:** directly present in `YNABSharedLibMobile.packaged.min.js` from the signed Android artifact described below.
- **O-WA — observed, web-adjacent:** directly present in a public artifact that executes against or types the web app, such as Toolkit for YNAB. This is evidence about the web runtime's exposed shape, but it is third-party code.
- **C-O — corroborated, official:** stated by YNAB's public API SDK/docs or support documentation.
- **C-3 — corroborated, third party:** present in OpenTabs or another reproducible public project, sometimes with its maintainers' runtime-capture notes.
- **I — inferred:** follows from multiple observations but is not itself exposed as a named contract.
- **U — unknown:** not recoverable from the selected static artifacts and must not be guessed.

“Observed” means the code or string exists, not that every branch was exercised. “Required” means the client code unconditionally reads or validates a field; it does not necessarily mean the server rejects its omission in all versions.

## 2. Executive findings

1. **The public API and the app sync API are different protocols.** **C-O/O-M.** The official JavaScript SDK exposes REST resources under `/v1/plans/...`, authenticates with a public API bearer token, and explicitly says transaction reads exclude pending transactions. The shared application core posts an RPC-like form to `/api/v1/catalog`, with `operation_name=syncBudgetData` and JSON in `request_data`, authenticated by an application session token plus device/version headers.

2. **The private sync endpoint moves document deltas, not transaction resources.** **O-M.** Budget requests contain two knowledge frontiers, schema versions, a sync type, and a `changed_entities` envelope. Transactions are one entity family among accounts, categories, calculations, payees, scheduled transactions, money movements, and other budget state.

3. **YNAB's shared core is an identity-map/unit-of-work system.** **O-M/O-WA.** `EntityManager` owns typed collections and lookup methods. Local property changes allocate document knowledge, emit signals, and join a `ChangeSet`. The store serializes only entities in the unsent knowledge interval. Server objects merge while local knowledge incrementing is suspended.

4. **Transaction writes are aggregate writes.** **O-M/C-3.** The request key is `be_transaction_groups`, whose members contain one `be_transaction` plus its `be_subtransactions`. If the parent changes, the shared core emits all children; if a child changes, it emits the parent and sibling children. A transaction row alone is not the complete mutation contract.

5. **Pending is a real private entity state, not merely a UI decoration.** **O-M/O-WA.** The exact source vocabulary includes `raw_pending`, `Pending`, `ImportedPending`, and `matched_pending`. Raw bank rows are staged, normalized, optionally matched, displayed, approved/rejected, and sometimes transformed into several linked mutations. The public API omits that lifecycle.

6. **A correct writer should use the business layer or reproduce its compound invariants.** **O-M/I.** Changing only `accepted` is unsafe. Approval can change date, source, category, transfers, matches, and counterpart acceptance. Rejection/delete tombstones related entities and repairs transfer relationships.

7. **The analyzed mobile artifact contains no class named `SyncManager`.** **O-M.** Sync orchestration lives primarily in the store (`BaseStore`/`MobileStore`), while `MobileServerSyncController` only suspends/resumes synchronization. This was an artifact-scoped uncertainty: the separately hashed current web bundle does contain the `SyncManager` surface and choreography documented in [YNAB_WEB_CLIENT_RUNTIME.md](./YNAB_WEB_CLIENT_RUNTIME.md).

8. **Knowledge must be persisted conservatively.** **O-M/I.** In the mobile implementation, incoming rows and an intermediate knowledge row are committed together; only after that succeeds does the store advance `deviceKnowledgeOfServer` and persist the final knowledge. This establishes the important crash-safety direction—never advance a receive cursor before entities commit—but does not prove that every platform commits final cursor plus rows in one transaction.

9. **Schemas drift.** **O-M/C-3.** The analyzed mobile artifact uses catalog schema `16`, budget schema `44`, and family schema `4`; OpenTabs code pinned to April 2026 uses budget schema `41`. An independent client needs a version-discovery/compatibility strategy, not a timeless constant copied from this report.

## 3. Artifact provenance and reproducibility

### 3.1 Signed YNAB Android artifact

The strongest first-party-code-adjacent static artifact recovered without authentication was an Android APK from a third-party mirror. It is not called “official source” here. Its package identity and signer were checked independently.

Source URL:

`https://pool.apk.aptoide.com/aptoide-web/com-youneedabudget-evergreen-app-263200-76284052-fccb5e533900bdd35ccd93942010ba63.apk`

Public package corroboration:

- Google Play package: <https://play.google.com/store/apps/details?id=com.youneedabudget.evergreen.app>
- Mirror version history: <https://ynab.en.aptoide.com/versions>

Artifact facts:

| Property | Value |
|---|---|
| Android package | `com.youneedabudget.evergreen.app` |
| Version | `26.32.0` |
| Version code | `263200` |
| APK size | `44,835,811` bytes |
| APK MD5 | `fccb5e533900bdd35ccd93942010ba63` |
| APK SHA-256 | `fcb35eea7dc942804970233d94145617e5f3bdb1ba30d01d7e1ef67b06248611` |
| Shared JS asset | `assets/javascript/YNABSharedLibMobile.packaged.min.js` |
| Shared JS size | `2,220,316` bytes |

`apksigtool 0.1.0` reported both APK Signature Scheme v2 and v3 verified. That tool identifies itself as a prototype, so this is strong corroboration rather than a formal supply-chain attestation. The embedded signer certificate decoded to:

| Certificate property | Value |
|---|---|
| Subject | `C=US, ST=Utah, L=Lehi, O=YouNeedABudget.com, OU=Android, CN=YNAB` |
| SHA-1 | `51:C5:B3:98:90:A6:F4:37:8D:04:C1:78:9D:67:9E:DF:2A:C5:F9:67` |
| SHA-256 | `1a9db568eea7a3c7adc6462111fe1a518aacc5df8a47a6c3ebbc4f638a5ccb1c` |
| Validity | 2015-06-18 through 2040-06-11 |

The bundle ends with `//# sourceMappingURL=YNABSharedLibMobile.packaged.min.js.map`, but the map is absent from the APK. The bundle was beautified without semantic rewriting; line numbers cited below refer to `/tmp/ynab-sharedlib.pretty.js` in the research environment. The extracted-JavaScript SHA-256, formatter name/version/command, and pretty-output hash were not retained. Consequently those temporary line numbers are research locators, not independently reproducible citations; the APK hash, asset path, unique method/string names, and short excerpts are the durable locators. A future refresh must record all four missing reproducibility values before claiming line-level reproduction.

Minimal verification sequence:

```sh
shasum -a 256 ynab-26.32.0.apk
unzip -l ynab-26.32.0.apk assets/javascript/YNABSharedLibMobile.packaged.min.js
apksigtool verify ynab-26.32.0.apk
```

### 3.2 Public repositories

All GitHub links below are commit-pinned.

| Artifact | Commit | Role |
|---|---|---|
| [YNAB JavaScript SDK](https://github.com/ynab/ynab-sdk-js/tree/bf72e5809032f680d72b2887b04307acd9097278) | `bf72e5809032f680d72b2887b04307acd9097278` | Official public-API contract |
| [Toolkit for YNAB](https://github.com/toolkit-for-ynab/toolkit-for-ynab/tree/da9022ccdb203bebf005eba4b2010111b52c76e4) | `da9022ccdb203bebf005eba4b2010111b52c76e4` | Web runtime names/types |
| [OpenTabs YNAB plugin](https://github.com/opentabs-dev/opentabs/tree/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab) | `de9200b1231cae419d1a437e410114a9e2fe8eca` | Independent private-protocol implementation |

The anonymous bundles served by the logged-out YNAB account/login application were also inspected. They did not contain `YNABSharedLib`, `SyncManager`, `EntityManager`, or `syncBudgetData`. Therefore this appendix does **not** claim to statically recover the current authenticated web budget bundle.

The npm registry returned 404 for `@ynab/shared-lib`, and a registry search for `YNABSharedLib` returned no package at analysis time. This supports the conclusion that the app library is not intentionally published as a public npm contract; it does not rule out a renamed or private package. The official public SDK package is `ynab@4.5.0`, whose `package.json` says it was generated from server specification `1.85.0`.

### 3.3 Exact representative excerpts

The following short excerpts establish the central protocol facts without reproducing substantial proprietary code.

**O-M, private RPC envelope** (`/tmp/ynab-sharedlib.pretty.js:62778`):

```js
sendCatalogRequest(operation, data) {
  return this.sendServerRequest('/api/v1/catalog', {
    operation_name: operation,
    request_data: JSON.stringify(data)
  }, 'POST', operation);
}
```

**O-M, literal operation mapping** (`:62795-62830`):

```js
syncBudgetDataWithServer(data) {
  return this.sendCatalogRequest('syncBudgetData', data);
}
loginUserWithSessionToken(data) {
  return this.sendCatalogRequest('getInitialUserData', data);
}
```

**O-WA, web shared-library entry point** ([Toolkit `ynab.ts`](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/extension/utils/ynab.ts#L8-L10)):

```ts
export function getEntityManager() {
  return ynab.YNABSharedLib.defaultInstance.entityManager;
}
```

**C-3, independent request construction** ([OpenTabs `ynab-api.ts`](https://github.com/opentabs-dev/opentabs/blob/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab/src/ynab-api.ts#L157-L185)):

```ts
fetch('/api/v1/catalog', {
  method: 'POST',
  credentials: 'include',
  body: `operation_name=${encodeURIComponent(operationName)}` +
        `&request_data=${encodeURIComponent(JSON.stringify(requestData))}`
});
```

**C-O, public API exclusion** ([official SDK Transactions API](https://github.com/ynab/ynab-sdk-js/blob/bf72e5809032f680d72b2887b04307acd9097278/src/docs/TransactionsApi.md#L249-L310)):

> Returns plan transactions, excluding any pending transactions.

Research locator map for the beautified mobile artifact:

These line numbers locate the temporary beautified output used during this investigation. The
beautifier command/output hash was not retained, so they are not independently reproducible
coordinates. Durable claims must instead be checked against the recorded source artifact hash and
the cited literals/method relationships; see the provenance caveat above.

| Lines | Evidence |
|---|---|
| `19970-20060` | exported managers/constants |
| `20573-20600` | `MobileServerSyncController` |
| `25473-25546` | `Knowledge` and `BudgetKnowledge` |
| `33171-33179` | catalog/budget/family schema versions |
| `34991-35095` | entity states, knowledge suspension, observable merge |
| `35552-35583` | exact transaction-source constants and source sets |
| `43090-43220` | match-source mapping and candidate sets |
| `44240-44645` | raw import normalization and post-sync trigger |
| `45056-45155` | transaction-editor approve-on-save behavior |
| `45530-46200` | update/approve/reject/delete/transfer semantics |
| `50296-50309` | normal calculation source SQL set |
| `50611-50641` | pending display-only filter and ordering |
| `52372-52650` | mobile persistence manager |
| `53668-53682` | `device_info` construction |
| `53920-54520` | catalog/budget/family sync state machines |
| `55135-55460` | outbound knowledge-window queries and grouping |
| `57320-57806` | change-set managers and mobile undo |
| `58663-60250` | base/mobile entity managers |
| `62590-62895` | base HTTP adapter and v1 operations |
| `63392-63860` | aggregate/shared/mobile instance graph and defaults |
| `97665-97694` | global export attachment and source-map reference |

## 4. Public REST API versus application document sync

| Dimension | Public API | Private application sync |
|---|---|---|
| Evidence | **C-O** | **O-M**, web use **C-3/O-WA** |
| Primary route | `/v1/plans/{plan_id}/transactions` | `/api/v1/catalog` |
| Model | Resource-oriented REST | RPC operation carrying document deltas |
| Operation selection | HTTP method + path | Form field `operation_name` |
| Payload | JSON request/response models | Form-encoded `request_data` containing JSON |
| Auth | `Authorization: Bearer <public API token>` | `X-Session-Token`, application session/cookies, device/version headers |
| Incremental read | `last_knowledge_of_server` | `device_knowledge_of_server` plus per-device send frontier |
| Response cursor | `data.server_knowledge` | `current_server_knowledge`, `server_knowledge_of_device` |
| Transaction behavior | Explicitly excludes pending | Carries source-state transaction entities, including pending |
| Mutation granularity | Transaction endpoints | Entity groups inside a whole-budget sync |
| Stability/support | Documented public contract | Undocumented, versioned internal contract |

The official SDK at the pinned commit is package `ynab@4.5.0`, generated from server specification `1.85.0`. Its generated `TransactionsResponseData` requires `{transactions, server_knowledge}`. The private response uses different names and a different two-dimensional knowledge model. Similar terminology does not imply cursor interchangeability.

## 5. Shared-library object layout

### 5.1 Export surface

At bundle end, the mobile artifact exports two globals:

- `ynab_mobile`: a facade of application operations.
- `ynab_mobile_exposed`: namespaces exposing constructors/constants/query helpers.

`ynab_mobile_exposed` contains **O-M**:

```text
baseErrors
baseEnums
baseConstants
baseCollections
baseViewModelsCategorySetWizard
baseManagers
baseViewModelsSupport
managers
queries
utilities
viewStateModels
features
checkbox
masterCategory
testFixtures
```

Relevant exported base managers include `EntityManager`, `SignalsManager`, `ChangeSet`, `ChangeSetManager`, `DirectImportManager`, calculation managers, and entity editors. Relevant mobile managers include:

```text
MobileEntityManager
MobilePersistenceManager
MobileServerSyncController
MobileChangeSetManager
MobileDirectImportManager
MobileCalculationsManager
MobileTransactionEditor
MobileTransactionManager
MobileTransactionValidator
```

Relevant constants include `TransactionSource`, `TransactionState`, `TransactionDisplayItemType`, `EntityStates`, account/category enums, and calculation queue types. Collections include transaction and scheduled-transaction collections.

### 5.2 Recovered class graph

Minified identifiers are included only so another analyst can reproduce searches in this exact artifact:

```text
Tc  Base shared-library instance (environmentType = Web)
└─ Ec  Mobile shared-library instance (environmentType = Mobile)

Ac  API adapter
├─ bc  catalog API v1
├─ Sc  API v2
├─ fc  labs API
└─ Cc  online/resource API helper

yu  BaseStore
└─ Yu  MobileStore

Wu  SignalsManager
└─ cl  EntityManager
   └─ ec  MobileEntityManager

Uu  ChangeSetManager
└─ Hu  MobileChangeSetManager

xu  ChangeSet
eu  MobilePersistenceManager
se  MobileServerSyncController
pt  Knowledge
└─ bt  BudgetKnowledge
```

The base shared-library constructor creates, in order, an API adapter, store, entity manager, change-set manager, and formatting manager. The mobile subclass substitutes mobile implementations and adds the mobile transaction manager and server-sync controller. **O-M.**

The base instance exposes `store`, `entityManager`, `changeSetManager`, `deviceInfo`, `deviceId`, `sessionToken`, active user/family/budget objects, and formatters. This aligns with Toolkit's web-visible `YNABSharedLib.defaultInstance.entityManager`, but the web default-instance bootstrap itself is **U**.

### 5.3 Configuration defaults

The recovered base configuration object initializes **O-M**:

```text
databaseFileName                         YNAB
refreshDatabaseAtStartup                false
useEmber                                true
serverUrl                               http://127.0.0.1:3000/
initializeWithAutoSync                  true
timeBetweenAutoSyncChangesFromServer    60000
initializeAsReadOnly                    false
timeToWaitAfterChangeToPushChanges      10
useTwoStepInitialSync                   false
```

The mobile facade changes `useEmber` to `false` and disables automatic sync before instantiating the mobile shared library. The unit of `timeToWaitAfterChangeToPushChanges` is **U** from this constructor alone. `useTwoStepInitialSync` has no other reference in this mobile bundle; its web semantics are **U**, despite the suggestive name.

### 5.4 Facade operations

The exact `ynab_mobile` facade exports **O-M**:

```text
initializeSharedLibrary
getSharedLibInstance
clearSharedLibraryInstance
createObjectInstance
createObjectInstanceWithAsyncFactory
setLogLevel
loginUser
loginUserSSO
loginUserSessionToken
setUserSession
logoutUser
initiatePasswordReset
resetPassword
registerNewUserAndLogin
syncCatalogAndFamilyData
setActiveBudget
syncBudgetData
syncBudgetDataForInactiveBudget
suspendSyncingWithServer
resumeSyncingWithServer
isSyncingWithServerSuspended
performFullCalculations
performPendingCalculations
hasPendingCalculations
canUndoChangeSetWithToken
undoChangeSetWithToken
generatePendingTransactions
generateUpcomingTransactionNow
createNewBudget
deleteBudget
canLoggedInUserFreshStartActiveBudget
validateFamilyInvite
getKustomerJwt
isForethoughtEnabled
reconcileAccount
ensureDataForMonthExists
resetBudget
mobileTransactionManagerExecute
recordSubscriptionReceipt
migrateCatalogAndFamilySchemaIfNecessary
migrateAllLocalBudgetsForThisUserIfNecessary
buildLoginUserResult
flushEntityManager
persistChangesLocally
initFormatters
didUserCompleteCategoryWizard
showCategoryWizardAfterLogin
stageDirectImportData
enablePrivacyMode
```

Two names are explicitly stubs in this artifact: `syncBudgetDataForInactiveBudget` throws “not implemented yet”, and `reconcileAccount` throws “not implemented”. `generatePendingTransactions` refers to firing scheduled transactions that are due, not bank-feed pending rows; the overloaded word “pending” must not be confused with `TransactionSource.Pending`.

## 6. Network adapter and operation contract

### 6.1 Operation-name construction

There is no discovered naming algorithm. **O-M.** The v1 adapter methods pass literal strings to one generic `sendCatalogRequest` method:

```text
Method                                    operation_name
syncCatalogDataWithServer                 syncCatalogData
syncBudgetDataWithServer                  syncBudgetData
syncFamilyDataWithServer                  syncFamilyData
login                                     loginUser
loginUserWithSessionToken                 getInitialUserData
logout                                    logoutUser
initiatePasswordReset                     initiatePasswordReset
resetPassword                             resetPassword
registerNewUser                           signupUser
createNewBudget                           createNewBudget
deleteBudget                              deleteBudget
freshStartABudget                         freshStartABudget
unlinkAccountFromDirectImport             unlinkAccount
stageDirectImportData                     stageDirectImportData
recordSubscriptionReceiptToServer         recordSubscriptionReceipt
```

The request is a form object:

```json
{
  "operation_name": "syncBudgetData",
  "request_data": "{...JSON string...}"
}
```

The mobile code hands that object to jQuery without setting JSON content mode, so standard jQuery form serialization is expected. **O-M/I.** Exact browser-generated `Content-Type`, cookie inclusion, and `X-Requested-With` behavior are environment-dependent and therefore **U** for a standalone client unless captured. OpenTabs explicitly sends `application/x-www-form-urlencoded; charset=UTF-8`, `credentials: include`, and `X-Requested-With: XMLHttpRequest`, which is useful **C-3**, not a server guarantee.

### 6.2 Adapter families

The aggregate `ApiAdapter` exposes **O-M**:

- `v1`: `/api/v1/catalog`, catalog-operation form, `useTokenAuth=false`.
- `v2`: `/api/v2/<route>`, resource-style user/family/budget endpoints, `useTokenAuth=false`.
- `labs`: `/api/labs/<route>`, `useTokenAuth=true`.
- `onlineApi`: `/api/<route>`, JSON/resource helper, `useTokenAuth=true`.

When `useTokenAuth=true`, the base adapter adds `Authorization: Token <sessionToken>`. That is not the public API's `Authorization: Bearer <personal-access-token>` scheme. V1/v2 still send the session token through `X-Session-Token` when configured.

### 6.3 Request headers

For each attempt, the base adapter creates a UUID and builds these headers **O-M**:

| Header | Construction |
|---|---|
| `X-YNAB-Client-Request-Id` | New UUID for that `sendServerRequest` invocation |
| `X-YNAB-Api-Version` | `2026-01-01` in all recovered adapter families |
| `X-YNAB-Device-Id` | Unconditional; client throws if absent |
| `X-YNAB-Device-Name` | Optional, URI-encoded |
| `X-YNAB-Device-Type` | Optional |
| `X-YNAB-Device-OS` | Optional; mobile falls back to `Unknown` |
| `X-YNAB-Device-OS-Version` | Optional |
| `X-YNAB-Device-App-Version` | Optional device value; global current app version overrides it if present |
| `X-Castle-Request-Token` | Optional, when Castle globals are configured |
| `X-Session-Token` | Present when application session token is configured |
| `Authorization` | `Token <sessionToken>` only for `labs`/`onlineApi` in this artifact |
| `X-YNAB-Mobile-App` | `Mobile` for the mobile instance |
| `Content-Type` | Explicit JSON only when adapter call requests JSON mode |

The adapter extracts `X-YNAB-Server-Version` from responses. Cookies are not explicitly constructed by the shared core; jQuery/browser behavior supplies them if applicable. Whether the private catalog endpoint currently requires a cookie in addition to `X-Session-Token` is **U** from static code. OpenTabs claims both an HttpOnly session cookie and the meta-tag token participate, but that is **C-3** and needs runtime validation.

### 6.4 Retry and error behavior

The adapter recognizes `Retry-After` only if its value consists exclusively of decimal digits. It multiplies by 1,000 and retries up to a default count of 10. **O-M.** The retry recursively calls `sendServerRequest`, so it allocates a new `X-YNAB-Client-Request-Id`; it is not an idempotent retry under the same request ID. HTTP-date `Retry-After` is not handled in this artifact.

Responses are rejected if either the HTTP request fails or the JSON body has a truthy top-level `error`. The precise error JSON schema remains **U**; the shared exception class attempts to expose status, ID, and a data object.

### 6.5 Read-only guard

V1 read-only mode permits `loginUser`, `logoutUser`, and `getInitialUserData`. It permits sync operations only when:

```text
ending_device_knowledge <= starting_device_knowledge
```

All other v1 operations are blocked. V2 permits GET only. **O-M.**

Important limitation: the v1 helper named `hasChangedEntities` compares only those two counters. It does not traverse `changed_entities`. A standalone read-only implementation should enforce both:

1. no send-frontier advance, and
2. a recursively empty/absent mutation envelope.

Otherwise a malformed request could carry rows while satisfying the library's narrow counter test.

### 6.6 Session-token initialization

`loginUserWithSessionToken(token)` **O-M**:

1. logs out if a different user session is already installed;
2. sets the adapter's `sessionToken`;
3. sends `getInitialUserData` with `{device_info: getDeviceInfo()}`;
4. requires the response to contain at least `session_token` and a valid `user` object;
5. replaces the configured token with `response.session_token`;
6. stores optional `castle_user_jwt` and `user_help_access_initial_jwt`;
7. delegates to platform-specific login handling.

The exact `device_info` shape is:

```json
{
  "id": "<device-id>",
  "device_name": "<name>",
  "device_type": "<type>",
  "device_os": "<os>",
  "device_os_version": "<version>",
  "browser_name": "<browser>",
  "browser_version": "<version>",
  "ynab_app_version": "<app-version>"
}
```

Static code proves the keys the client sends; which values are server-required and whether today's web client sends all of them are **U**.

## 7. Knowledge model

### 7.1 State variables

The base `Knowledge` class contains **O-M**:

| Property | Meaning inferred from use |
|---|---|
| `currentDeviceKnowledge` | Highest local sequence allocated by this device |
| `serverKnowledgeOfDevice` | Highest local sequence the server reports accepting |
| `deviceKnowledgeOfServer` | Highest server sequence the client has applied |
| `lastDeviceKnowledgeLoadedFromLocalStorage` | Local identity-map refresh frontier |
| `lastDeviceKnowledgeSavedToLocalStorage` | Local identity-map persistence frontier |
| `schemaVersionOfKnowledge` | Schema in which stored knowledge/entities are understood |

`incrementDeviceKnowledge()` pre-increments and returns `currentDeviceKnowledge`. `resetValues(schema)` resets the first three knowledge counters to zero and sets the schema. `BudgetKnowledge` adds `queueCalculationsForServerEntities`.

The distinction between the two server/device counters is fundamental:

```text
client's outbound axis
  currentDeviceKnowledge ───────────────┐
  serverKnowledgeOfDevice ──acknowledged┘

server's inbound axis
  deviceKnowledgeOfServer ──applied receive cursor
```

This is not the public API's single `server_knowledge` cursor.

### 7.2 Outgoing selection rule

Mobile SQL selects every mutable entity family with **O-M**:

```sql
deviceKnowledge > serverKnowledgeOfDevice
AND deviceKnowledge <= currentDeviceKnowledge
```

The lower bound omits already acknowledged changes. The upper bound freezes the request snapshot, so edits allocated while the request is in flight are reserved for the next sync.

For transaction aggregates the store additionally queries parent, child, and sibling rows. A changed subtransaction causes its parent transaction and all sibling subtransactions to be included; a changed parent causes all children to be included. The same pattern is used for scheduled transaction groups.

### 7.3 Persistence rows and recovery

The mobile database contains document knowledge rows for global/catalog, family, and each budget version, plus a stable device ID in global settings. **O-M.** Family and budget loaders scan loaded entity `deviceKnowledge` values; if a row is ahead of persisted `currentDeviceKnowledge`, they advance current knowledge to `maxEntityKnowledge + 1`. This repairs a local entity/knowledge mismatch conservatively. The catalog loader does not expose the same max-scan path in this artifact.

No standalone client should reuse another application's device ID while maintaining an independent local journal. **I.** The server's `serverKnowledgeOfDevice` belongs to the `(account/session, document, device identity)` history. Two unsynchronized writers sharing the identity can make each other's acknowledged frontier ambiguous.

### 7.4 Schema versions

The analyzed mobile artifact returns **O-M**:

```text
catalogSchemaVersion = 16
budgetSchemaVersion  = 44
familySchemaVersion  = 4
local DB migration   = 112
```

These are artifact facts, not recommended constants. OpenTabs pins budget schema `41` and documents it as working in an earlier capture **C-3**. The server/client compatibility policy, minimum accepted app version, and schema negotiation rules are only partly visible and remain runtime-sensitive.

## 8. Sync request and response contracts

### 8.1 Sync types

The exact enum is **O-M**:

```text
bootstrap
backfill
delta
```

The current mobile bundle contains branches for all three but no discovered mobile call site that explicitly requests `bootstrap` or `backfill`; ordinary calls default to `delta`. Therefore the branch semantics below are observed, while when/how today's web client chooses them is **U**.

OpenTabs states that, at schema 41, `bootstrap` returned roughly recent history while zero-knowledge `delta` returned full history **C-3**. This conflicts with a simplistic interpretation of the enum and must not be generalized without current runtime traces.

### 8.2 Catalog request

```ts
interface CatalogSyncRequest {
  user_id: UUID;
  schema_version: number;
  schema_version_of_knowledge: number;
  starting_device_knowledge: number;
  ending_device_knowledge: number;
  device_knowledge_of_server: number;
  changed_entities: CatalogChangedEntities;
}
```

Construction is **O-M**:

```text
starting_device_knowledge = serverKnowledgeOfDevice
ending_device_knowledge   = currentDeviceKnowledge snapshot
device_knowledge_of_server = applied server cursor
```

### 8.3 Family request

```ts
interface FamilySyncRequest {
  family_id: UUID;
  starting_device_knowledge: number;
  ending_device_knowledge: number;
  device_knowledge_of_server: number;
  schema_version: number;
  schema_version_of_knowledge: number;
}
```

No `changed_entities` member is constructed. Base entity-manager logic also refuses family knowledge increment for local changes. **O-M.** This makes family sync read-oriented in the recovered core; family mutations occur through separate v2 endpoints or other paths.

### 8.4 Budget request

```ts
type SyncType = 'bootstrap' | 'backfill' | 'delta';

interface BudgetSyncRequest {
  budget_version_id: UUID;
  sync_type: SyncType;
  starting_device_knowledge: number;
  ending_device_knowledge: number;
  device_knowledge_of_server: number;
  calculated_entities_included: false;
  schema_version: number;
  schema_version_of_knowledge: number;
  changed_entities: BudgetChangedEntities;
}
```

For `delta` and `bootstrap`, the normal send snapshot is used. For `backfill`, this client forces both `starting_device_knowledge` and `ending_device_knowledge` to `0` while retaining the existing `device_knowledge_of_server`. **O-M.** If ending knowledge is zero, the code supplies an object whose supported changed-entity keys are present with `undefined` values rather than querying local changes; actual form JSON serialization omits those values.

### 8.5 Response fields used by the client

All three handlers unconditionally read or validate these fields **O-M**:

```ts
interface SyncResponse<E> {
  changed_entities: E;
  current_server_knowledge: number;
  server_knowledge_of_device: number;
  schema_version_of_response: number;
  error?: unknown;
}
```

The budget response also feeds calculation-queue logic and direct-import processing. Other optional top-level fields are **U**.

The client requires `schema_version_of_response === current client schema` and separately requires it not be older than `schemaVersionOfKnowledge`. This is strict equality in the analyzed artifact—not a generic “accept any newer schema” rule.

### 8.6 Core state machine

For each document, the store **O-M**:

1. rejects or coalesces a second in-flight sync of the same type;
2. validates device/session/document prerequisites;
3. snapshots current knowledge and persists it locally;
4. selects outgoing entities in the frozen interval;
5. constructs the request and sends it;
6. validates response schema;
7. sets `serverKnowledgeOfDevice` from the response;
8. rejects “server knows more about this device than the device knows about itself”, except that a zeroed fresh client may adopt the server value;
9. detects whether local knowledge advanced during the await;
10. conditionally merges/persists incoming entities;
11. after successful handling, advances schema/server receive knowledge and persists knowledge;
12. performs post-sync direct-import normalization when applicable.

Catalog and family ignore incoming rows whenever local device knowledge advanced during the request. Budget ignores incoming rows for that reason only when `sync_type === delta`; bootstrap/backfill are allowed to proceed under the branch as written. **O-M.** The policy rationale is inferred to avoid merging against an entity graph that changed after the request snapshot.

For a response whose `server_knowledge_of_device` exceeds nonzero local `currentDeviceKnowledge`, the normal path throws. A server error with ID `server_knowledge_of_device_exceeds_device_knowledge` is specially ignored only when the error's reported value is less than or equal to local current knowledge. **O-M.**

### 8.7 Cursor advancement by sync type

On successful budget response handling **O-M**:

- `delta`: advances `schemaVersionOfKnowledge` and `deviceKnowledgeOfServer` if the handler says knowledge should persist.
- `backfill`: does the same, despite sending zero on the outbound device axis.
- `bootstrap`: does **not** advance those two persisted receive-knowledge fields in this branch.
- non-bootstrap, non-read-only: runs `possiblyImportTransactionsAfterBudgetSync`.

The exact orchestration that turns bootstrap plus backfill/delta into the web UI's initial staged load is **U** from this artifact.

### 8.8 Stale-response and concurrency guards

Across asynchronous work, the store compares the active user/family/budget identity and can throw a `StaleResponseError` if the target changed. **O-M.** This matters for a CLI daemon with parallel commands: a response for budget A must never be applied to budget B just because one global “active budget” pointer changed.

The mobile controller's sync suspension is stack-depth based. Its public methods only delegate:

```text
suspendSyncingWithServer
resumeSyncingWithServer
isSyncingWithServerSuspended
description
mobileStore
```

It does not own cursor logic or expose a general `SyncManager` API.

## 9. Changed-entity envelopes

### 9.1 Catalog

Catalog upload/merge collections **O-M**:

```text
ce_users
ce_user_budgets
ce_user_settings
ce_user_privacy_policy_agreements
```

### 9.2 Family

Family response collections **O-M**:

```text
fe_family                 singleton in the server envelope
fe_family_members         array
```

The local database representation sometimes pluralizes `fe_families`; that is a storage/query name, not evidence that the wire sends an array under that key.

### 9.3 Budget upload

The budget request builder emits these keys **O-M**:

```text
be_budget                              singleton
be_expected_income                     singleton
be_accounts
be_account_mappings
be_master_categories
be_monthly_budgets
be_monthly_subcategory_budgets
be_onboarding_events
be_onboarding_targets
be_payees
be_payee_locations
be_payee_rename_conditions
be_settings
be_subcategories
be_scheduled_transaction_groups
be_transaction_groups
be_transaction_images
be_money_movements
be_money_movement_groups
```

Transaction group shape:

```ts
interface TransactionGroup {
  id: UUID;
  be_transaction: TransactionWire;
  be_subtransactions: SubTransactionWire[] | null;
}
```

Scheduled group shape:

```ts
interface ScheduledTransactionGroup {
  id: UUID;
  be_scheduled_transaction: ScheduledTransactionWire;
  be_scheduled_subtransactions: ScheduledSubTransactionWire[] | null;
}
```

The group `id` is the parent ID in all recovered construction paths. Exact server validation of group ID equality is **U**.

### 9.4 Budget response

The response/persistence code recognizes the flattened server collections **O-M**:

```text
first_month
last_month
be_accounts
be_budget
be_expected_income
be_account_calculations
be_account_mappings
be_master_categories
be_monthly_account_calculations
be_monthly_budgets
be_monthly_budget_calculations
be_monthly_subcategory_budgets
be_monthly_subcategory_budget_calculations
be_onboarding_events
be_onboarding_targets
be_payees
be_payee_locations
be_payee_rename_conditions
be_scheduled_subtransactions
be_scheduled_transactions
be_settings
be_subcategories
be_subtransactions
be_transactions
be_transaction_images
be_money_movement_groups
be_money_movements
```

Thus requests group parent/children while responses flatten them. A protocol implementation needs separate request and response schemas rather than one symmetric `ChangedEntities` type.

### 9.5 Calculation entities

The request fixes `calculated_entities_included: false` and does not upload calculation collections. **O-M.** Responses can still carry account/month/category calculation rows. The mobile store maintains a calculation queue and can recompute denormalized values locally. Whether the server accepts `true`, and the exact web behavior when it does, are **U**.

## 10. Entity identity, observation, and change tracking

### 10.1 Collections and identity map

`EntityManager` owns lazily created typed collections **O-M**:

```text
Catalog
  users, userSettings, userBudgets, userPrivacyPolicyAgreements

Family
  families, familyMembers

Budget source
  accountMappings, accounts, budgets, expectedIncomes,
  masterCategories, monthlyBudgets, monthlySubCategoryBudgets,
  onboardingEvents, onboardingTargets, payeeLocations,
  payeeRenameConditions, payees, scheduledSubTransactions,
  scheduledTransactions, settings, subCategories, subTransactions,
  transactions, transactionImages, moneyMovements, moneyMovementGroups

Budget calculation
  accountCalculations, accountMonthlyCalculations,
  monthlyBudgetCalculations, monthlySubCategoryBudgetCalculations
```

Specialized collections maintain secondary indexes—for example transaction by account/payee/category and subtransaction by parent. `findEntity(type, id)` dispatches to a typed collection; `attachEntityToEntityManager` rejects an already attached entity and inserts by type.

### 10.2 Entity states

Exact `EntityStates` values **O-M**:

```text
attached
detached
detachedNew
```

New entities begin `detachedNew`. `createEntityCloneForEditing` serializes an attached entity through its server converter, constructs a clone, merges the original, and marks the clone `detached`. Calling `mergeBackDetachedEntity` delegates to the entity manager:

- `detached`: merge into existing identity-map entity, retaining the maximum device knowledge;
- `detachedNew`: attach, allocate knowledge, and emit entity-created;
- `attached`: warning/no detached merge path.

Entities can be marked non-mergeable, and `ensureEntityIsMergeable` rejects their merge.

### 10.3 Observable property semantics

Entity properties are instrumented with native getters/setters. A changed observed value produces `{refEntity, propertyName, originalValue, newValue}`. **O-M.** Manual batch mode coalesces repeated changes to the same property, retaining the first original value and final new value. Equal date-without-time values, equal JavaScript dates, and equal domain value objects do not create effective changes.

An attached entity's change runs inside `performAsSingleChangeSet`. The manager:

1. allocates catalog or budget knowledge unless knowledge incrementing is suspended;
2. sets the entity's `deviceKnowledge` to that sequence;
3. emits generic and type-specific change signals.

Local family-entity knowledge increment throws, consistent with the read-oriented family sync path.

### 10.4 Server merge semantics

`mergeServerObjectIntoEntity` **O-M**:

1. suspends knowledge increment for the target entity;
2. batch-merges the server object's properties;
3. sets `deviceKnowledge` to `0`.

A new server object is created, attached, announced as added, and also set to knowledge zero. Knowledge zero therefore means “server/base state”, not “unsaved local edit”.

This matters to an independent client: applying remote rows through ordinary local setters without suppressing change tracking would immediately echo them back as locally authored changes.

### 10.5 Signals

The signal manager exposes generic `entityCreated`, `entityPropertyChanged`, and `serverEntityReceived`, plus type-specific signals for accounts, transactions, subtransactions, scheduled rows, categories, monthly budgets, and calculations. **O-M.** Toolkit corroborates the web runtime's private transaction signal:

```js
ynab.YNABSharedLib.defaultInstance.entityManager
  ._transactionEntityPropertyChanged.addHandler(...)
```

See [Toolkit import notification](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/extension/features/general/import-notification/index.js#L20-L26). This is **O-WA** evidence that the same conceptual event system has existed in the web runtime.

### 10.6 Change sets and undo

`ChangeSetManager` listens to entity-created/property-changed signals and groups nested edits. **O-M.** It monitors:

```text
masterCategory, subCategory, monthlyBudget, monthlySubCategoryBudget,
transaction, subTransaction, scheduledTransaction,
scheduledSubTransaction, setting, account, payee, payeeLocation,
payeeRenameCondition, moneyMovement, moneyMovementGroup,
expectedIncome, transactionImage, onboardingEvent, onboardingTarget
```

It deliberately does not monitor calculation entities, `budget`, or `accountMapping`. A `ChangeSet` stores created/changed records and can reapply/revert them, including special handling for transaction relationships and money movements.

`MobileChangeSetManager`:

- supports synchronous token-scoped undoable operations;
- can undo consecutive change sets bearing the same token;
- persists reverted catalog/budget entities locally;
- caps its undo stack at 100;
- has an unimplemented `redo()` in this artifact.

A CLI does not need to duplicate the UI undo stack to read pending rows, but the atomic grouping tells us which compound operations YNAB considers one user edit.

## 11. EntityManager method inventory

The following is the method surface directly recovered from the base `EntityManager` class **O-M**. It is included because many historical descriptions name methods without distinguishing actual library APIs from UI services.

### 11.1 Lifecycle, merge, and knowledge methods

```text
getSharedLibInstance
getFirstMonthForBudget
getLastMonthForBudget
initialize
finalize
changeSetManager (getter)
resetBudgetEntityCollections
resetBudgetSourceEntityCollections
resetBudgetCalculationCollections
resetCatalogEntityCollections
resetFamilyEntityCollections
budgetCollections (getter)
budgetCalculationCollections (getter)
getNextCatalogKnowledgeValue
getCurrentCatalogKnowledgeValue
getNextBudgetKnowledgeValue
getCurrentBudgetKnowledgeValue
performAsSingleChangeSet
performAsSingleChangeSetAsync
performWithSuspendedUndoRedo
batchChangeProperties
generateEntityCreatedSignal
generateEntityAddedEvent
generateServerEntityReceivedEvent
generateEntityPropertyChangedSignal
onEntityChanged
incrementEntityKnowledge
handleSyncedServerObjects
mergeEntityFromServerObject
mergeServerObjectIntoEntity
createAndAttachEntityFromServerObject
createEntityCloneForEditing
createBlankEntity
mergeDetachedEntity
invalidateEntityCache
ensureEntityIsMergeable
cloneAccount
cloneMasterCategory
cloneSubCategory
clonePayee
cloneTransaction
cloneSubTransaction
cloneMonthlySubCategoryBudget
cloneMonthlySubCategoryBudgetCalculation
findEntity
findOrLoadEntity
attachEntityToEntityManager
```

### 11.2 Catalog and family lookups

```text
getUserById
getUserByEmail
getAllUserBudgets
getAllNonTombstonedUserBudgetsByUserId
getUserBudgetById
getUserBudgetByBudgetVersionId
getUserBudgetsByUserId
getOwnedUserBudgetsByUserId
getSharedUserBudgetsByUserId
getUserBudgetByUserIdAndBudgetId
getUserBudgetByUserIdAndBudgetVersionId
isUserAuthorizedForBudgetVersion
getUserSettingById
getUserSettingsByUserId
getUserSettingByUserIdAndSettingName
getUserPrivacyPolicyAgreementById
getUserPrivacyPolicyAgreementByUserId
getFamilyById
getFamilyMemberById
getActiveFamilyMembersByFamilyId
getAllFamilyMembers
getFamilyMemberByFamilyIdAndUserId
```

### 11.3 Budget/account/category/payee lookups

```text
getBudgetById
getExpectedIncomeById
getAccountById
getAccountByName
getAllAccounts
getAllFavoriteAccounts
getAllNonTombstonedAccounts
isAccountDeletable
getAccountCalculationById
getAccountCalculationByAccountId
getAllAccountCalculations
getAccountMonthlyCalculationById
getAccountMonthlyCalculationByAccountIdAndMonth
getAccountMonthlyCalculationsByAccountId
getAllAccountMonthlyCalculationsByMonthString
getAllAccountMonthlyCalculations
getAccountMappingById
getAllAccountMappings
getMasterCategoryById
getMasterCategoryByName
getMasterCategoryByInternalName
getAllMasterCategories
getAllNonTombstonedMasterCategories
getSubCategoryById
getSubCategoryByName
getSubCategoriesByName
getSubCategoriesByNameFuzzyMatch
getSubCategoryByInternalName
getSubCategoriesByMasterCategoryId
getSubCategoryByAccountId
getAllSubCategories
getPayeeById
getPayeeByName
getPayeeByInternalName
getPayeeByAccountId
getAllPayees
getPayeeLocationById
getPayeeLocationsByPayeeId
getPayeeLocation
getAllPayeeLocations
getPayeeRenameConditionById
getPayeeRenameConditionsByPayeeId
getPayeeRenameCondition
getAllPayeeRenameConditions
getAllNonTombstonedPayeeRenameConditions
```

### 11.4 Transaction and scheduled-transaction lookups

```text
getTransactionById
getTransactionImageById
getTransactionImagesByTransactionId
addTransactionImage
removeTransactionImage
getNonTombstone (static)
getTransactionsByPayeeId
getTransactionsByAccountId
getTransactionsByAccountIdAndMonth
internalGetTransactionsByAccountId
getVisibleTransactionsByAccountId
getTransactionsBySubCategoryId
getTransactionsByImportedPayee
getAllTransactions
getAllUnapprovedTransactions
getAllUncategorizedTransactions
getImportableTransactionsByAccountId
getMatchCandidateTransactionsByAccountId
getSubTransactionById
getSubTransactionsByTransactionId
getSubTransactionsBySubCategoryId
getAllSubTransactions
getSubTransactionsByPayeeId
getScheduledTransactionById
getScheduledTransactionsByAccountId
getVisibleScheduledTransactionsByAccountId
getScheduledTransactionsByTransferAccountId
getAllScheduledTransactions
getScheduledSubTransactionById
getScheduledSubTransactionsByScheduledTransactionId
getScheduledSubTransactionsByTransferAccountId
getAllScheduledSubTransactions
```

### 11.5 Settings, months, movements, and changed sets

```text
getSettingById
getSettingBySettingName
hasSettingWithName
getAllSettings
getMonthlyBudgetById
getMonthlyBudgetByMonth
getAllMonthlyBudgets
getMonthlyBudgetCalculationById
getMonthlyBudgetCalculationByMonthlyBudgetId
getAllMonthlyBudgetCalculations
getMonthlySubCategoryBudgetById
getMonthlySubCategoryBudgetsByMonthlyBudgetId
getMonthlySubCategoryBudgetsByMonth
getMonthlySubCategoryBudgetsByMonthISOString
getMonthlySubCategoryBudgetsBySubCategoryId
getMonthlySubCategoryBudgetByMonthlyBudgetIdAndSubCategoryId
getMonthlySubCategoryBudgetCalculationById
getMonthlySubCategoryBudgetCalculationByMonthlySubCategoryBudgetId
getMoneyMovementById
getAllNonTombstonedMoneyMovements
getAllMoneyMovements
getLastStartedNonTombstonedMoneyMovement
getFilteredMoneyMovementsForRecentMoves
getMoneyMovementsByMoneyMovementGroupId
getMoneyMovementsByMSCBId
getMoneyMovementGroupById
getAllMoneyMovementGroups
getOnboardingEventById
getAllOnboardingEvents
getAllNonTombstonedOnboardingEvents
getOnboardingEventByName
getOnboardingTargetById
getAllOnboardingTargets
getAllNonTombstonedOnboardingTargets
getChangedCatalogEntities
getChangedBudgetEntities
```

Toolkit's much smaller TypeScript interface corroborates only `getAccountById`, `getTransactionById`, transaction/category queries, collections, and `performAsSingleChangeSet`; see [the commit-pinned type](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/types/ynab/window/ynab-entity-manager/index.ts#L1-L14). Absence from Toolkit's hand-maintained type is not evidence that a method is absent from web.

## 12. Store and persistence architecture

### 12.1 Store responsibilities

The base store—not `EntityManager`—owns **O-M**:

- session, logged-in user, active family/budget;
- the three knowledge objects;
- catalog/family/budget in-flight flags;
- request construction and response validation;
- selecting outgoing entities through platform hooks;
- post-sync direct-import processing;
- cached first/last budget month.

`MobileStore` supplies database-backed entity selection, local-load/save, migrations, calculation orchestration, and permission cleanup. This separation is important for a potential standalone library: entity business rules and wire/store orchestration are distinct layers.

### 12.2 Database behavior

`MobilePersistenceManager` targets a WebSQL/SQLite-like query utility. **O-M.** It constructs parameterized query lists and executes them with synchronous write helpers. Converters map between server snake_case objects, database camelCase rows, and entity objects.

The generic persistence primitive uses replacement semantics for full rows. Some migrations/query helpers support partial updates, but independent writes should assume the sync wire expects complete entity shapes unless validated otherwise. OpenTabs independently reports that a minimal tombstone transaction payload received HTTP 400 and therefore round-trips the full row **C-3**.

The database carries denormalized calculated values and a separate `calculationsDeviceKnowledge`. Incoming/source changes can enqueue recalculation for accounts, monthly accounts, transactions, scheduled transactions, categories, and monthly category budgets.

### 12.3 Incoming commit ordering

The mobile response path has a two-stage knowledge write **O-M**:

1. `saveBudgetServerEntitiesToDatabase` builds incoming entity queries, clears the queue flag, appends a budget-knowledge-row write, then executes the list together. At this moment the knowledge object contains the response's `serverKnowledgeOfDevice`, but still the old `deviceKnowledgeOfServer`.
2. After response handling returns, the base store sets `schemaVersionOfKnowledge` and `deviceKnowledgeOfServer = current_server_knowledge`, then calls `persistBudgetKnowledgeValues` again.

Catalog and family use the same broad ordering. This means:

- entities are never skipped by advancing the receive cursor before their commit;
- a crash between stages can replay already committed incoming rows;
- replacement/upsert semantics make that replay tolerable;
- the final receive cursor and incoming rows are not proven to be in one SQL transaction in this mobile artifact.

The safe standalone invariant is therefore:

```text
commit/upsert all incoming entities first
then durably advance the receive cursor
```

Using one database transaction for rows plus final cursor is a reasonable stronger design **I**, but it is not an exact description of the recovered mobile implementation.

### 12.4 Local identity-map persistence

When a mobile change set closes, the store writes entity-manager changes newer than `lastDeviceKnowledgeSavedToLocalStorage`, then advances that local-save frontier. Loading from storage reads rows newer than `lastDeviceKnowledgeLoadedFromLocalStorage`, merges them, and advances the local-load frontier. **O-M.** These local-storage frontiers are internal to the app and do not appear in the server request.

## 13. Pending-transaction domain model

### 13.1 Exact source vocabulary

`TransactionSource` is a string/null vocabulary **O-M**, independently matching Toolkit's web type **O-WA**:

```ts
const TransactionSource = {
  Scheduler:       'Scheduler',
  RawImport:       'raw_import',
  RawPending:      'raw_pending',
  Imported:        'Imported',
  Pending:         'Pending',
  ImportedPending: 'ImportedPending',
  Matched:         'Matched',
  MatchedImport:   'matched_import',
  MatchedPending:  'matched_pending',
  None:            null
};
```

See [Toolkit's commit-pinned constants](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/types/ynab/window/ynab-constants/index.ts#L56-L83).

The mobile core defines three useful sets **O-M**:

```text
User-visible/source-valid:
  Scheduler, Matched, Imported, ImportedPending, Pending, null

Raw staged:
  raw_import, raw_pending

Normal calculation sources:
  Scheduler, Matched, Imported, ImportedPending, null
```

`Pending` is deliberately absent from the normal calculation set. A register SQL comment states that pending rows are display-only and “do not affect the budget”; the query adds `Pending` only when a `show pending` argument is set. It sorts scheduled rows first, pending rows second, and the rest afterward. **O-M.**

YNAB's current support article independently says pending rows do not affect categories, balances, or even uncleared balance; editing/entering one moves it into the register, and the later cleared import can match it. **C-O.** See [Pending Transactions in YNAB](https://support.ynab.com/en_us/pending-transactions-an-overview-Bk0WoOcA5), last updated 2026-07-27 when fetched for this report.

### 13.2 Staging and normalization

The server can deliver transaction rows whose source is `raw_import` or `raw_pending`. After a non-bootstrap, writable budget sync, `possiblyImportTransactionsAfterBudgetSync` checks for non-tombstoned raw-source rows; when present, it runs `DirectImportManager.importTransactions()` with undo tracking suspended and persists local results. **O-M.** A forced backfill can also invoke that path.

Normal import processing **O-M**:

```text
raw_import
  → is_tombstone = false
  → accepted = false (normal feature path)
  → cleared = Cleared
  → source = Imported

raw_pending
  → is_tombstone = false
  → accepted = false (normal feature path)
  → cleared = Uncleared
  → source = Pending
```

The manager then resolves/creates a payee from imported text, applies payee/category autofill, assigns the inflow category in a narrow checking-account case, repairs transfer semantics, and attempts matching. Therefore the raw server row is not necessarily the final row shown to the user; a read client that skips the normalization layer may expose `raw_pending` records the UI has not yet classified.

### 13.3 Matching

The matching helper defines a maximum ten-day separation and candidate source pairs **O-M**:

```text
(manual/null, Imported)
(manual/null, Pending)
(manual/null, ImportedPending)
(Scheduler, Imported)
(Scheduler, Pending)
(Scheduler, ImportedPending)
(Pending, Imported)
(ImportedPending, Imported)
```

Raw import candidates can match `null`, `Scheduler`, `ImportedPending`, or `Matched`; raw pending candidates can match `null` or `Scheduler`. Matching maps an import-side source to:

```text
raw_import / Imported          → matched_import
raw_pending / Pending /
ImportedPending                → matched_pending
```

Unmatching maps `matched_import` back to `Imported`; the pending-side restoration differs by branch (`Pending` or `ImportedPending`). The library stores `matched_transaction_id`, and UI queries resolve the companion row. **O-M.**

The exact winning-row/losing-row representation of every match permutation, especially what the server later sends after clearing, should be runtime-captured before a CLI exposes `--include-matched-pending`. **U.** A naive list of both `Pending` and `matched_pending` can double count one economic event.

### 13.4 Edit/approve transition

`TransactionEditor` starts with `_approveOnSave = true`; editing an existing transaction calls the internal approval path unless explicitly disabled. This matches the support article's statement that any edit enters a pending row into the register. **O-M/C-O.**

For `source === Pending`, approval performs this compound operation **O-M**:

1. if matched, accept the match; otherwise set `accepted = true`;
2. if the date is future-dated, replace it with today;
3. set `source = ImportedPending` when the account still has active direct import, otherwise `source = null`;
4. if the assigned category is hidden, clear the category;
5. create/update/remove transfer relationships and counterpart entities as needed;
6. merge the detached edit back into the identity map;
7. automatically approve the transfer counterpart, accepting its match if necessary;
8. update payee autofill/rename state and potentially tombstone orphan payees through the editor path.

The mobile facade's action named `Approve` goes through this editor, validation, and save path. A direct sync writer that merely sends `{accepted: true}` does not implement YNAB's approval semantics.

### 13.5 Reject/delete transition

Reject is defined only for an unaccepted existing transaction **O-M**:

- matched pending: reject the match through the matching helper;
- split-transfer counterpart: reject the parent transaction;
- otherwise: delete the transaction and its subtransactions.

Delete is a soft-delete compound change **O-M**:

1. mark the transaction tombstoned;
2. tombstone its transaction images;
3. if its source is `Pending`, first change source to `ImportedPending`;
4. tombstone its matched companion if present;
5. repair/remove transfer links and possibly tombstone counterpart structures;
6. tombstone subtransactions and repair their transfers;
7. merge all changed rows;
8. optionally rerun direct import checks.

OpenTabs independently reports that the server rejects a minimal transaction tombstone and requires a full transaction-shaped member inside `be_transaction_groups` **C-3**; see [delete implementation and capture note](https://github.com/opentabs-dev/opentabs/blob/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab/src/tools/delete-transaction.ts#L37-L55).

### 13.6 Transfer propagation

Transfer repair deserves separate treatment. **O-M.** When a transaction's payee denotes another account, the business layer may create a counterpart with inverse amount, mirrored account/payee, linked `transfer_transaction_id` or `transfer_subtransaction_id`, and synchronized date/memo/flag. When a pending side becomes non-pending, the counterpart can be converted from `Pending` to `ImportedPending` or `null` and accepted. When the transfer becomes invalid or a side is deleted, references are cleared and counterpart rows/images/children may be tombstoned.

Therefore approval, edit, and delete must lock or serialize the whole transaction aggregate plus counterpart aggregate. A standalone writer that does not support transfers should reject them explicitly rather than partially mutate them.

### 13.7 Pending-read evidence inventory and normative handoff

This appendix establishes the source vocabulary and relationships; it does not define NAB's output
policy. The current evidence shows that `accepted` is orthogonal to pending state, `raw_pending` is
pending provider staging, `raw_import` belongs to the posted-import lifecycle, and a visible
`Matched` row may be paired with a hidden `matched_pending` row. A reader therefore cannot use
`accepted == false` as a pending predicate or treat both raw sources as one staged class.

Retain these fields when analyzing pending behavior:

```text
source
matched_transaction_id
ynab_id
imported_payee
original_imported_payee
provider_cleansed_payee
imported_date
transfer_account_id
transfer_transaction_id
transfer_subtransaction_id
```

Evidence-level classifications:

```text
raw pending stage       source == 'raw_pending'
provider pending        source == 'Pending'
entered provisional     source == 'ImportedPending'
hidden pending match    source == 'matched_pending'
visible pending match   source == 'Matched' with a reciprocal matched_pending peer
posted import stages    source in {'raw_import', 'Imported', 'matched_import'}
```

The normative default-output, match-failure, deduplication, and completeness rules are in
[YNAB_CATALOG_PROTOCOL.md](./YNAB_CATALOG_PROTOCOL.md) and
[NAB_BROWSER_BRIDGE_PROTOCOL.md](./NAB_BROWSER_BRIDGE_PROTOCOL.md). At this snapshot they include raw
pending, provider pending, and the visible side of a valid pending match by default; entered
provisional is opt-in; the hidden match side is never emitted independently. Those are profile
decisions layered on this evidence and may change only through a versioned normative profile.

### 13.8 Historical mutation-complexity ladder (not an authorization)

The mobile static evidence suggested this relative complexity ladder during archaeology. It is not
a “safe tier” table, implementation recommendation, or permission to enable private writes. Every
private mutation tier is outside `pending-read-v1` and is currently prohibited:

| Tier | Behavior | Static confidence |
|---|---|---|
| 0 | Historical read/list observation; no private write | High as static evidence; current product mode still provider-gated |
| 1 | Local annotations with no provider request | High as static evidence; outside this protocol product surface |
| 2 | Hypothetical invocation of the loaded business layer | Medium historical hypothesis; prohibited |
| 3 | Hypothetical independent simple approval | Medium-low historical hypothesis; prohibited |
| 4 | Hypothetical match, split, transfer, delete, or bulk compound mutation | Low; prohibited |

The only current normative conclusion is no private mutation. If YNAB ever authorizes a separate
writable profile, these rows explain why calling one field update “approval” would be incomplete;
that future profile would require its own contract, consent, recovery, and differential fixtures.

## 14. Wire-field registry

This section is an exact **field-name inventory** recovered from server/entity/database converters in the analyzed mobile core **O-M**. It is not JSON Schema:

- it does not prove server-requiredness;
- it does not exhaust response-only feature-flag additions;
- it does not specify nullability for every field;
- it does not establish whether an omitted field differs from explicit `null`;
- field types should be validated from captures before generation.

Amounts are integer milliunits in all observed transaction/budget paths (1 currency unit = 1,000 milliunits), independently corroborated by the public API and OpenTabs **C-O/C-3**. Server date fields are commonly ISO calendar strings while the mobile database uses converted timestamp/date representations; use the wire converter, not database types, as the network guide.

### 14.1 Transaction aggregates

`be_transactions` / `be_transaction_groups[].be_transaction`:

```text
id
is_tombstone
entities_account_id
entities_payee_id
entities_subcategory_id
entities_scheduled_transaction_id
date
date_entered_from_schedule
amount
cash_amount
credit_amount
credit_amount_adjusted
subcategory_credit_amount_preceding
memo
cleared
accepted
check_number
flag
transfer_account_id
transfer_transaction_id
transfer_subtransaction_id
matched_transaction_id
ynab_id
imported_payee
imported_date
original_imported_payee
provider_cleansed_payee
source
debt_transaction_type
```

`be_subtransactions` / group children:

```text
id
is_tombstone
entities_transaction_id
entities_payee_id
entities_subcategory_id
amount
cash_amount
credit_amount
credit_amount_adjusted
subcategory_credit_amount_preceding
memo
check_number
transfer_account_id
transfer_transaction_id
sortable_index
```

`be_transaction_images`:

```text
id
is_tombstone
entities_transaction_id
```

### 14.2 Scheduled transactions

`be_scheduled_transactions` / scheduled group parent:

```text
id
is_tombstone
entities_account_id
entities_payee_id
entities_subcategory_id
date
frequency
amount
memo
flag
transfer_account_id
upcoming_instances
debt_transaction_type
```

`be_scheduled_subtransactions` / scheduled group children:

```text
id
is_tombstone
entities_scheduled_transaction_id
entities_payee_id
entities_subcategory_id
amount
memo
transfer_account_id
sortable_index
```

### 14.3 Accounts and account calculations

`be_accounts`:

```text
id
is_tombstone
account_type
account_name
note
last_payment_payee_id
is_closed
sortable_index
is_favorite
sortable_favorite_index
on_budget
last_reconciled_at
direct_import_status
direct_import_institution_name
direct_import_account_name
direct_import_aggregated_at
direct_import_balance
direct_import_available_balance
debt_start_date
debt_original_balance
debt_interest_rates
debt_minimum_payments
debt_asset_values
debt_escrow_amounts
debt_migrated_from_account_id
```

`be_account_calculations`:

```text
id
is_tombstone
entities_account_id
cleared_balance
uncleared_balance
info_count
warning_count
error_count
transaction_count
debt_last_payment_date
debt_payments
```

`be_monthly_account_calculations`:

```text
id
is_tombstone
month
entities_account_id
cleared_balance
uncleared_balance
rolling_balance
info_count
warning_count
error_count
transaction_count
debt_interest_due
debt_interest_paid
debt_escrow_paid
debt_estimated_interest_paid
debt_estimated_escrow_paid
debt_last_payment_date
debt_payments
```

`be_account_mappings`:

```text
id
is_tombstone
fid
shortened_account_id
hash
salt
entities_account_id
date_sequence
should_flip_payees_memos
should_import_memos
skip_import
```

### 14.4 Budget, months, and category budgeting

`be_budget`:

```text
id
is_tombstone
budget_id
budget_name
date_format
currency_format
source
```

`be_expected_income`:

```text
id
user_entered_income
is_tombstone
```

`be_monthly_budgets`:

```text
id
is_tombstone
month
note
```

`be_monthly_budget_calculations`:

```text
id
is_tombstone
entities_monthly_budget_id
immediate_income
budgeted
cash_outflows
credit_outflows
balance
over_spent
available_to_budget
uncategorized_cash_outflows
uncategorized_credit_outflows
uncategorized_balance
additional_to_be_budgeted
age_of_money
```

`be_monthly_subcategory_budgets`:

```text
id
is_tombstone
entities_monthly_budget_id
entities_subcategory_id
budgeted
goal_snoozed_at
```

`be_monthly_subcategory_budget_calculations`:

```text
id
is_tombstone
entities_monthly_subcategory_budget_id
cash_outflows
positive_cash_outflows
credit_outflows
balance
budgeted_cash_outflows
budgeted_credit_outflows
unbudgeted_cash_outflows
unbudgeted_credit_outflows
budgeted_previous_month
spent_previous_month
payment_previous_month
balance_previous_month
budgeted_average
spent_average
payment_average
budgeted_spending
all_spending
all_spending_since_last_payment
additional_to_be_budgeted
upcoming_transactions
upcoming_transactions_count
upcoming_transactions_first_date
goal_overall_funded
goal_overall_outflows
goal_under_funded
goal_target
goal_overall_left
goal_expected_completion
goal_percentage_complete
```

### 14.5 Category hierarchy

`be_master_categories`:

```text
id
is_tombstone
internal_name
deletable
sortable_index
name
note
is_hidden
```

`be_subcategories`:

```text
id
is_tombstone
entities_master_category_id
entities_account_id
internal_name
sortable_index
name
type
note
goal_type
goal_created_on
goal_needs_whole_amount
goal_target_amount
goal_target_date
goal_cadence
goal_cadence_frequency
goal_day
monthly_funding
is_hidden
pinned_index
pinned_goal_index
```

### 14.6 Payees

`be_payees`:

```text
id
is_tombstone
entities_account_id
enabled
auto_fill_subcategory_id
auto_fill_user_defined_subcategory_id
auto_fill_memo
auto_fill_amount
auto_fill_subcategory_enabled
auto_fill_memo_enabled
auto_fill_amount_enabled
rename_on_import_enabled
name
internal_name
```

`be_payee_locations`:

```text
id
is_tombstone
entities_payee_id
latitude
longitude
```

`be_payee_rename_conditions`:

```text
id
is_tombstone
entities_payee_id
operator
operand
```

### 14.7 Money movements

`be_money_movements`:

```text
id
is_tombstone
to_entities_monthly_subcategory_budget_id
from_entities_monthly_subcategory_budget_id
entities_money_movement_group_id
amount
performed_by_user_id
note
source
move_started_at
move_accepted_at
```

`be_money_movement_groups`:

```text
id
is_tombstone
performed_by_user_id
source
note
month
group_created_at
deleted_entities_subcategory_id
```

### 14.8 Settings and onboarding

`be_settings` outgoing conversion:

```text
id
setting_name
setting_value
```

The entity/database model includes tombstone state, but the outgoing converter inventory omits `is_tombstone` for this entity; do not synthesize it without validation.

`be_onboarding_events`:

```text
id
is_tombstone
event_name
user_id
created_at
updated_at
```

`be_onboarding_targets`:

```text
id
is_tombstone
calculated_amount
user_amount
funding_amount
cadence
cadence_day
spending_breakdown
```

### 14.9 Catalog entities

`ce_users`, outbound/common fields:

```text
id
username
email
trial_expires_on
initial_intention
is_subscribed
first_name
family_id
family_role
age_group
sign_in_count
annual_subscription_price
required_privacy_policy_version
self_reported_source
is_referral_program_available
created_at
```

The inbound user converter additionally recognizes:

```text
trial_days_remaining
initial_budget_template
```

`ce_user_budgets`:

```text
id
budget_version_id
user_id
is_tombstone
budget_id
budget_name
source
permissions
last_modified_at
```

`ce_user_settings`:

```text
id
user_id
setting_name
setting_value
```

`ce_user_privacy_policy_agreements`:

```text
id
user_id
version
source
client_agreed_at
```

### 14.10 Family entities

`fe_family`:

```text
id
is_tombstone
```

`fe_family_members`:

```text
id
family_id
is_tombstone
user_id
first_name
email
family_role
owned_budget_ids
shared_budget_ids
display_initial
sort_index
```

### 14.11 Pending-relevant decision-sufficient modeled projection

An independent pending reader does not need to materialize every field above. The bounded reader's
decision-sufficient modeled transaction projection should include **I**:

```text
id, is_tombstone, entities_account_id,
entities_payee_id, entities_subcategory_id,
date, amount, memo, cleared, accepted, flag,
source, matched_transaction_id,
transfer_account_id, transfer_transaction_id,
transfer_subtransaction_id,
ynab_id, imported_payee, imported_date,
original_imported_payee, provider_cleansed_payee,
entities_scheduled_transaction_id,
debt_transaction_type
```

That projection is sufficient only for the bounded zero-change reader, which discards unknown fields
and never round-trips a row. A hypothetical writer would need a separately specified full aggregate
and unknown-field policy. OpenTabs documents why careless reconstruction is unsafe: nulling
`imported_date` broke bank-feed dedup and led to duplicate imports; its current implementation
spreads the existing row before applying changes. See [the commit-pinned update note](https://github.com/opentabs-dev/opentabs/blob/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab/src/tools/update-transaction.ts#L89-L122). **C-3.**

## 15. Web-adjacent corroboration

### 15.1 Toolkit for YNAB

Toolkit is a mature third-party web extension, not YNAB documentation. Its value is that it names objects actually consumed from the web page.

At commit `da9022ccdb203bebf005eba4b2010111b52c76e4`, Toolkit shows **O-WA**:

- the shared instance at `ynab.YNABSharedLib.defaultInstance`;
- `.entityManager` on that instance;
- account and transaction lookups;
- `performAsSingleChangeSet`;
- `transactionsCollection` and `payeesCollection`;
- transaction fields including `accepted`, `source`, `matchedTransactionId`, transfer IDs, imported payee/date, and `ynabId`;
- exact transaction source/state/display constants matching the mobile artifact;
- direct import through `new ynab.managers.DirectImportManager(entityManager, account)`;
- transaction-property-change signals.

Primary files:

- [shared-lib entry point](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/extension/utils/ynab.ts#L8-L10)
- [EntityManager type](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/types/ynab/window/ynab-entity-manager/index.ts)
- [transaction type](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/types/ynab/data/transaction.ts)
- [constants](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/types/ynab/window/ynab-constants/index.ts#L56-L83)
- [DirectImportManager use](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/extension/features/general/import-notification/index.js#L77-L95)

Toolkit's TypeScript declarations are partial and hand-maintained. They corroborate shape; they do not define completeness, wire serialization, or present-day method stability.

### 15.2 OpenTabs

OpenTabs is an independent browser plugin that directly implements the private protocol. At commit `de9200b1231cae419d1a437e410114a9e2fe8eca`, it **C-3**:

- reads the session token from `<meta name="session-token">`;
- reads user ID from `YNAB_CLIENT_CONSTANTS.USER`;
- takes the budget-version/plan ID from the app URL;
- generates and caches a plugin-specific UUID device ID;
- sends `X-Session-Token`, device ID/OS/app-version, `X-Requested-With`, and cookies;
- POSTs the same catalog form envelope;
- uses a zero-knowledge `delta` as a snapshot read;
- resolves transaction display names from separate collections;
- writes transaction aggregates under `be_transaction_groups`;
- preserves full existing rows on update;
- refuses transfers/splits in its generic transaction mutation tools.

Its central implementation is [ynab-api.ts](https://github.com/opentabs-dev/opentabs/blob/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab/src/ynab-api.ts). Useful empirical history:

- [PR #37](https://github.com/opentabs-dev/opentabs/pull/37): corrected the response to expose top-level `changed_entities` and `current_server_knowledge`.
- [PR #41](https://github.com/opentabs-dev/opentabs/pull/41): reports end-to-end validation of 16 tools; discovered separate name collections, exact `accepted`/`flag` fields, required transaction groups, and money-movement behavior.
- [PR #54](https://github.com/opentabs-dev/opentabs/pull/54): reports a successful write whose response omitted the changed transaction.
- [commit `7153a1b1`](https://github.com/opentabs-dev/opentabs/commit/7153a1b173ec3c9368d2cccab183cb8d60360dbc): preserves `imported_date` after duplicate bank imports were observed.

These are valuable differential-test clues, not a supported protocol specification.

### 15.3 Critical OpenTabs divergence

OpenTabs pins `BUDGET_SCHEMA_VERSION = 41`, while this mobile artifact uses `44`. More importantly, its writer always sends **C-3**:

```text
starting_device_knowledge = 0
ending_device_knowledge   = 1
```

and comments that it does not persist client knowledge. This contradicts the shared core's persistent per-device journal, in which each local mutation receives a sequence and subsequent writes begin at the server-acknowledged frontier. Possible explanations include permissive server behavior, plugin-specific device treatment, incomplete repeated-write coverage, or behavior that has since changed. **U.**

Do not copy the constant-one strategy into NAB. It is precisely the kind of empirical shortcut that can appear to work while undermining conflict detection or future compatibility.

## 16. Confidence matrix

This matrix is historical to the mobile/static artifact. “Unknown” here means not established by
that artifact alone. The current hashed web-bundle/runtime companions resolve the existence of the
web `SyncManager`, current schemas, two-step bootstrap/backfill flow, collection registries, and
in-memory/no-op persistence hooks for the reviewed web build. They do not resolve provider-only
auth, authorization, limits, or server guarantees. Where this appendix and those companions differ,
the current web runtime/provenance documents take precedence.

| Claim | Status | Evidence | Runtime validation still needed? |
|---|---|---|---|
| Public transaction reads exclude pending | Observed official contract | Official SDK/docs | No, except policy may someday change |
| Private sync route/form | Resolved for reviewed current web build | Mobile artifact + OpenTabs + hashed web runtime companion | Provider requiredness/release stability remain unknown |
| Operation name is `syncBudgetData` | Observed mobile + third party | Literal wrapper; OpenTabs | Low |
| Private auth uses `X-Session-Token` | Observed mobile + third party | Header builder; OpenTabs | Yes: cookie/Castle/CSRF requiredness |
| Device ID is required by client | Observed mobile | Header builder throws | Yes: server constraints and lifecycle |
| Request/response knowledge fields | Observed mobile | Store request/handler | Yes: server validation/error cases |
| Budget schema 44 | Observed artifact fact; independently resolved for reviewed web build | Version getters + current web companion | Revalidate on web-build/schema change |
| `bootstrap/backfill/delta` enum | Observed mobile; independently resolved for reviewed web build | Exact enum + current web companion | Provider retention/content windows remain unknown |
| Transactions sent as groups | Observed + empirical | Mobile SQL/builder; OpenTabs PR #41 | Validate pending mutations specifically |
| Response transactions flattened | Observed mobile | Persistence handler | Low/current-version check |
| Pending source strings | Observed mobile + web-adjacent | Constants; Toolkit | Low |
| Pending excluded from calculations | Observed + official support | SQL sets; support article | Low |
| Raw-pending normalization | Observed mobile | Direct import manager | Validate current web timing/feature branches |
| Approval compound semantics | Observed mobile + official UX | Editor; support article | Validate current web request diff |
| Reject/delete compound semantics | Observed mobile | editor/transfer helpers | Yes before any standalone write |
| Two-stage receive persistence | Observed mobile | persistence/store sequence | Current web in-memory merge/cursor order is separately documented; durable server guarantees unknown |
| Web exposes shared entity manager | Resolved for reviewed current web build | Toolkit + hashed web runtime companion | Revalidate on web-build change |
| Current web has `SyncManager` | Resolved by current web companion, not this mobile artifact | Hashed web bundle/runtime analysis | Revalidate on web-build change |
| Server echoes each successful write | Disproven as assumption | OpenTabs PR #54 | Model exact cases |
| Constant `(0,1)` writer is safe | Unknown/conflicting | OpenTabs vs shared core | Yes; assume unsafe |

## 17. Runtime-validation gaps

The following is the historical gap register that guided the later web analysis; it is not a current
implementation or live-testing checklist. Companion work has closed the static/runtime portions of
items 1, 2, 6, 7, and 28 and parts of 3 and 16 for the exact reviewed web build. Provider-requiredness,
auth/session/Castle behavior, limits, retention, errors, and identity longevity remain open. Items
17–27 concern private mutations or invasive writable-client validation: they are outside
`pending-read-v1` and MUST NOT be exercised without an explicit new provider-authorized protocol and
test authorization.

The remaining historical gaps prevent this appendix by itself from being called a complete current
server contract. They are ordered by implementation risk, not curiosity.

### 17.1 Read-only protocol gaps

1. **Current authenticated web bundle identity.** Recover chunk URLs, hashes, app version, schema versions, and source-map availability. Determine whether the web still exposes `YNABSharedLib.defaultInstance`, and inventory its store/entity/sync managers.
2. **Initial-load choreography.** Capture the exact sequence and payloads for bootstrap, backfill, and delta. YNAB's official [loading article](https://support.ynab.com/en_us/loading-your-data-in-the-ynab-app-S1F63hUDWl) says web loads last month, current month, and all future months before historical data **C-O**, but it does not name protocol calls.
3. **Pending placement by phase.** Determine whether pending rows arrive in bootstrap, backfill, delta, or more than one; identify dedup keys across phases.
4. **Auth minimum.** Test, without exposing secrets in logs, the exact requirement matrix for cookie, `X-Session-Token`, `X-Requested-With`, API/app version, device ID, device metadata, Origin/Referer, and Castle token.
5. **Session lifecycle.** Measure token rotation, expiry, logout invalidation, concurrent-session behavior, and whether `getInitialUserData` changes the token.
6. **Schema negotiation.** Capture current version, 426 body, minimum app version behavior, and whether schema mismatches return structured error IDs.
7. **Full response schema.** Record every top-level field, missing-versus-null behavior, collection sparsity, order, pagination/window metadata, and content encoding.
8. **Zero-knowledge read semantics.** Compare `bootstrap`, `backfill`, and `delta` from a new device against a known transaction fixture. OpenTabs's schema-41 observation must be retested.
9. **Rate limits/retries.** Determine 429 thresholds, `Retry-After` variants, server idempotency on client request ID, and safe polling interval.

### 17.2 Pending-state gaps

10. **Untouched pending fixture.** Capture a pending row's complete wire shape, including optional/import/provider IDs.
11. **Pending disappearance/replacement.** Observe what happens when a bank removes, changes, or clears a pending authorization.
12. **Cleared match.** Capture both sides before and after a cleared row matches an untouched pending row.
13. **Entered-early match.** Capture `Pending → ImportedPending`, then the later cleared import and final match/approval.
14. **Manual-match permutations.** Validate `matched_pending`, surviving row identity, tombstones, and whether both rows are sent/returned.
15. **Pending transfers/splits.** Establish whether they occur from providers and the exact counterpart/child invariants.
16. **Feature-flag branches.** The direct-import code contains flag-dependent behavior; determine which branches apply to current web users.

### 17.3 Mutation gaps

17. **Simple approval differential.** On a single isolated test pending row that is unmatched, unsplit, non-transfer, and non-future-dated, diff pre-state, the web UI request, server response, and post-delta state.
18. **Edit differential.** Repeat for memo, category, payee, amount, and date individually. Confirm which edits force approval and which auxiliary payee/rename rows appear.
19. **Delete/reject differential.** Capture full tombstone group, server echo/omission, and later provider behavior.
20. **Knowledge validation matrix.** Exercise repeated writes from one dedicated device ID, stale `device_knowledge_of_server`, duplicate client request IDs, timeouts after server commit, and concurrent UI edits.
21. **Idempotency/recovery.** Determine whether an identical aggregate replay duplicates, rejects, or upserts; test recovery when the response is lost.
22. **Permissions.** Validate owner/editor/view-only/shared-budget behavior and exact read/write error IDs.
23. **Unknown-field round trip.** Verify that preserving response fields is sufficient and identify server-computed fields that must be omitted or may be echoed unchanged.
24. **Server echo policy.** Catalog cases where a successful write does not return the mutated entity; a client must follow with delta/read rather than assume failure.

### 17.4 Library-invocation gaps

25. **Current web business API.** Confirm how the current web app constructs an editor for an existing pending row and which method corresponds to Enter Now/approve/reject.
26. **Change flush trigger.** Determine whether calling the entity/editor layer automatically schedules sync, and how to await durable server acknowledgement.
27. **Web persistence.** Identify IndexedDB/local-storage layout, transaction boundaries, multi-tab coordination, and cursor ownership.
28. **Manager naming.** Determine whether a web `SyncManager` exists, or whether store/services own orchestration as in the mobile core.

None of these gaps justifies touching a real budget. They should be answered with anonymous bundle analysis, passive traces, and then the smallest possible controlled fixture set in the explicitly authorized test budget.

## 18. Historical writable/mobile invariants and bounded-reader contrast

The journal/write material in this section applies only to a hypothetical future writable client
derived from the mobile artifact. It is not a recommendation or contract for
`pending-read-v1`. The bounded reader's normative behavior lives in
[YNAB_CATALOG_PROTOCOL.md](./YNAB_CATALOG_PROTOCOL.md): a fresh ephemeral logical device, permanent
`Kc = Ks = 0`, exact-empty changes, bounded modeled cache, discarded unknown fields, and no private
financial mutation.

### 18.1 Device and journal

```text
one durable random device ID per future writable private-sync installation/profile
one knowledge record per (user, budget-version, device ID)
monotonically allocate local entity sequence numbers
never share one device ID across unsynchronized journals
serialize writes per budget document
```

### 18.2 Read transaction

```text
snapshot local outbound frontier
send no changed rows
send current receive cursor
validate target user/budget/schema on response
upsert modeled rows; the bounded reader discards unknown fields rather than round-tripping them
commit rows before advancing receive cursor
follow staged initial-load phases until historical completion is known
```

### 18.3 Future writable transaction (excluded from `pending-read-v1`)

```text
refresh/delta before editing
clone complete existing aggregate
apply business-layer transition
allocate local knowledge to every changed source row
send parent + all children under be_transaction_groups
include linked counterpart/match/payee rows when business rules changed them
retain unsent journal until serverKnowledgeOfDevice acknowledges it
do not require response echo for success
follow with delta/read-after-write verification
```

### 18.4 Recovery

```text
timeout before response => outcome unknown, not failed
retry only from durable journal state
re-read server/device knowledge before inventing a new mutation
upsert re-delivered server rows idempotently
never advance receive cursor ahead of entity commit
surface conflicts instead of overwriting silently
```

### 18.5 Historical pending-write guard sketch (excluded, incomplete, and non-authorizing)

Before an independent simple approval, default-deny unless all are true:

```text
source == Pending
accepted == false
is_tombstone == false
matched_transaction_id == null
transfer_account_id == null
transfer_transaction_id == null
transfer_subtransaction_id == null
no live subtransactions
account exists and is writable
schema/app version is recognized
fresh preflight delta completed
```

No condition in this sketch authorizes a write. All private pending writes route the user to YNAB
unless a future provider-supported operation and separate normative protocol exist.

## 19. What “complete specification” can and cannot mean here

This appendix provides a broad inventory for the named static artifact in these dimensions:

- exported shared-library namespaces and relevant class graph;
- v1 operation mapping, request envelope, and header builder;
- knowledge-state variables and outgoing selection rule;
- catalog/family/budget request construction;
- response fields directly consumed and schema checks;
- recognized changed-entity collection names;
- entity/change-set/persistence architecture;
- pending source vocabulary and mobile business transitions;
- converter field inventories;
- cross-corroboration with official public API, Toolkit, and OpenTabs.

It is not—and static analysis cannot make it—a complete current server specification in these dimensions:

- current authenticated web bundle parity;
- server-side requiredness, validation, conflict resolution, and idempotency;
- cookie/session/Castle requirements;
- precise bootstrap/backfill window semantics;
- present schema/app-version compatibility;
- every pending and matched transition returned by live providers.

Those unknowns are explicitly enumerated instead of being filled with plausible guesses. Any future
provider-authorized runtime validation should promote each result into an observed contract with a
sanitized request/response fixture, app/schema version, test precondition, and replay outcome.

## 20. Source index

Official/public YNAB:

- [Official JavaScript SDK, pinned commit](https://github.com/ynab/ynab-sdk-js/tree/bf72e5809032f680d72b2887b04307acd9097278)
- [Official transaction endpoint docs, pinned commit](https://github.com/ynab/ynab-sdk-js/blob/bf72e5809032f680d72b2887b04307acd9097278/src/docs/TransactionsApi.md#L249-L310)
- [Official SDK transaction response model](https://github.com/ynab/ynab-sdk-js/blob/bf72e5809032f680d72b2887b04307acd9097278/src/models/TransactionsResponseData.ts)
- [Pending Transactions in YNAB](https://support.ynab.com/en_us/pending-transactions-an-overview-Bk0WoOcA5)
- [Loading Your Data in the YNAB App](https://support.ynab.com/en_us/loading-your-data-in-the-ynab-app-S1F63hUDWl)
- [YNAB Android package on Google Play](https://play.google.com/store/apps/details?id=com.youneedabudget.evergreen.app)

Web-adjacent and independent implementations:

- [Toolkit for YNAB, pinned tree](https://github.com/toolkit-for-ynab/toolkit-for-ynab/tree/da9022ccdb203bebf005eba4b2010111b52c76e4)
- [Toolkit shared-lib type](https://github.com/toolkit-for-ynab/toolkit-for-ynab/blob/da9022ccdb203bebf005eba4b2010111b52c76e4/src/types/ynab/window/ynab-shared-lib/index.d.ts)
- [OpenTabs YNAB plugin, pinned tree](https://github.com/opentabs-dev/opentabs/tree/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab)
- [OpenTabs private API adapter](https://github.com/opentabs-dev/opentabs/blob/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab/src/ynab-api.ts)
- [OpenTabs transaction schema](https://github.com/opentabs-dev/opentabs/blob/de9200b1231cae419d1a437e410114a9e2fe8eca/plugins/ynab/src/tools/schemas.ts)

## 21. Bottom line

The shared core explains why pending transactions are absent from the public API yet available to
the applications: they live in the private budget document as source-state entities and pass through
a client-side Direct Import state machine. The evidence is sufficient to specify a fail-closed,
zero-change research target, not to deploy a private reader today: page completeness, an authorized
browser execution realm, native anti-abuse/session semantics, provider limits, and written permission
are still gates. Private mutations are outside that target entirely.

For NAB, the defensible order is: request a documented public pending endpoint first; otherwise seek
a provider-approved browser contract; otherwise use an independent bank-data overlay while keeping
all YNAB writes on the public API. Do not ship a cookie-replay client or private business-layer writer
from this appendix.
