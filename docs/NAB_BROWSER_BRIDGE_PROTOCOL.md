# NAB Browser Bridge and Cookie-Capture Protocol

Status: design specification; not approved for implementation or distribution  
Version: `nab-ynab-bridge/1`  
Default capability: local pending-transaction projection with no financial/entity mutations

This document specifies the browser credential boundary, local IPC contract, normalized pending
API, and the technically possible cookie-capture fallback. It deliberately does not grant or infer
permission to use YNAB's undocumented interface. The release gate in
[YNAB_WEB_SYNC_AUTH_AND_PROTOCOL.md](./YNAB_WEB_SYNC_AUTH_AND_PROTOCOL.md) still applies.

## 1. Architecture decision

Three modes are distinct products and must never silently fall back into one another:

| Mode | Where YNAB credentials live | Where catalog requests run | Default |
| --- | --- | --- | --- |
| `page-snapshot` | Chrome only | Official page performs its normal sync; bridge only reads hydrated entities | Design preference; completeness signal currently unavailable |
| `browser-catalog` | Chrome only | Fixed read-only adapter in a provider-designated YNAB browser realm | Design target; unavailable under current evidence |
| `native-replay` | Exported to native helper | Native helper, with browser assistance still required for per-request anti-abuse material | Specified research boundary; dispatch disabled |

No private mode is currently conforming: page snapshot lacks the passively observable completeness
signal required by section 5.1, browser catalog lacks the provider-designated realm/session contract
required by section 10.1, and native replay is hard-disabled by section 9.2. These are independent
gates; a caller cannot fall back from one to another.

The preferred data path is:

```text
agent / nab CLI
     │ typed operation; never credentials
     ▼
per-user NAB broker
     │ authenticated local socket
     ▼
Chrome Native Messaging host
     │ Chrome-framed JSON
     ▼
MV3 extension service worker
     │ fixed packaged MAIN-world function
     ▼
selected app.ynab.com tab ──reads──▶ hydrated YNAB entity graph
```

Cookie capture is specified because it is technically feasible and was explicitly requested for
design analysis. It is not the recommended architecture: a copied web session has full browser
authority, rotates, depends on more than cookies, and cannot be made server-enforced read-only.

## 2. Mandatory safety properties

Every mode MUST satisfy these properties:

1. Exact origin: `https://app.ynab.com` with default HTTPS port only.
2. No caller-controlled URL, HTTP method, operation name, header, cookie query, JavaScript source,
   object property path, or catalog request body.
3. No credential, device ID, raw catalog body, or browser object crosses into an agent-visible
   process or response.
4. Private operations send no financial/entity mutation and an exactly empty sync change set.
   Session-token rotation, logical-device registration, cookie rotation, and knowledge
   acknowledgement may still change provider session/device bookkeeping; this profile does not
   claim a server-enforced side-effect-free or read-only scope. Public YNAB APIs remain the only NAB
   financial write path.
5. Every response is schema-validated and size-limited before crossing a trust boundary.
6. Pending text fields are data, never instructions; consumers must not execute or interpret payee
   or memo text as commands.
7. The selected plan is bound to a consent grant. A plan/account identity change fails closed.
8. Disconnect removes grants, pairing material, caches, and—when chosen—the dedicated profile.
9. Authentication failures, schema changes, Castle challenges, and provider throttling are surfaced;
   the bridge never bypasses them.
10. Provider permission is a build/release gate, not a runtime “I accept the risk” switch.

## 3. Chrome extension permission model

### 3.1 Snapshot-only manifest floor

```json
{
  "manifest_version": 3,
  "name": "NAB YNAB Bridge",
  "version": "0.1.0",
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "connect.html"
  },
  "permissions": ["activeTab", "nativeMessaging", "scripting", "storage", "webNavigation"],
  "optional_host_permissions": ["https://app.ynab.com/*"],
  "incognito": "not_allowed"
}
```

Host permissions are origin-wide even when a path appears in the pattern. Code MUST independently
enforce the exact origin and, for catalog mode, exact `/api/v1/catalog` path.

The extension ID MUST be stable. The Native Messaging host manifest's `allowed_origins` contains
exactly the packaged production extension origin. Development builds use a separate pinned ID and
separate host name; a development installer must not rewrite a production allowlist.

### 3.2 Additional cookie-capture permissions

`native-replay` needs separately requested optional permissions:

```json
{
  "optional_permissions": ["cookies", "webRequest"],
  "optional_host_permissions": ["https://app.ynab.com/*"]
}
```

The extension requests these only from a user gesture on a dedicated consent screen. They are
strictly one-capture permissions, not standing grant scope. Every terminal capture path MUST remove
all capture listeners and then run the mandatory one-shot grant-retirement/permission-cleanup rule
in section 9.3; there is no “keep permissions” or optional-removal choice.

The design expressly rejects:

- `<all_urls>`;
- `debugger`;
- proxy, history, downloads, clipboard, password, or broad tab access;
- Chrome profile database access or decryption;
- remote code;
- generic `fetch` or `eval` message handlers.

### 3.3 Nonsecret per-profile instance record

`storage` is used for exactly one nonfinancial, non-authorizing value:

```ts
type ExtensionProfileInstanceV1 = {
  schema: "nab.extension-profile-instance/1";
  generation: 1;
  instance_id: string;                 // canonical lowercase UUIDv4
  created_at: string;
};
```

The exact `chrome.storage.local` key is `nab_profile_instance_v1`. On first install the service
worker generates it with Chrome CSPRNG and calls `chrome.storage.local.setAccessLevel` with
`TRUSTED_CONTEXTS`; sync/session/managed storage are forbidden. The record is closed, contains no
provider/profile path or secret, and survives ordinary extension/browser updates. A malformed,
missing, or changed record after a connect association is never regenerated in place: every bound
port closes and foreground renewal creates a fresh record/grant only after disclosure. Extension
uninstall/profile deletion removes it; reinstallation is a new instance. Profile copying may clone
it, so simultaneous duplicate instance IDs are quarantined and the value is only anti-confusion,
not independent profile attestation. A research probe in an existing profile cannot turn a later
matching cleanup ack into proof that the original Chrome profile survived uncopied and cannot create
a Version 1 grant. Managed private modes require the stronger runtime profile attestation in section
4.4. For a dedicated profile, the
installer/launcher binds the instance during the connect port to the saved directory and Chrome
process identity. No other value may be placed in extension storage.

### 3.4 Native Messaging package contract

The production host name is exactly `com.nab.ynab_bridge`; development uses the distinct
`com.nab.ynab_bridge.dev` name, binary, state root, extension ID, and credential-store services.
Production code calls `chrome.runtime.connectNative("com.nab.ynab_bridge")` and never accepts a host
name from a caller. The installed production manifest is strict JSON with no duplicate/unknown keys
and this exact shape:

```json
{
  "name": "com.nab.ynab_bridge",
  "description": "NAB YNAB Bridge",
  "path": "/installer-resolved/absolute/path/to/nab-ynab-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://PRODUCTION_EXTENSION_ID/"]
}
```

The two uppercase/path tokens are installer substitutions, not runtime template syntax. `path` is
the absolute normalized path to the pinned, signed, owner/root-nonwritable host executable; it
contains no symlink component and is revalidated by file identity at launch. The origin substitutes
the one policy/release-pinned production extension ID and retains the trailing slash. No wildcard,
second origin, environment expansion, relative path, or user-edited field conforms.

On macOS the installer writes the manifest atomically to Chrome's user-scoped Native Messaging Hosts
directory resolved through the account/application-support API; on Linux it uses the corresponding
Chrome user configuration directory; on Windows it writes an owner-only manifest then registers its
absolute path under the current-user
`Software\\Google\\Chrome\\NativeMessagingHosts\\com.nab.ynab_bridge` default registry value.
System-wide installation is a separately signed enterprise package and cannot silently replace the
user-scoped contract. The installer verifies a read-back through Chrome's documented discovery path.
Chrome's native host receives the caller origin as its first platform argument (with the Windows
parent-window argument handled only as documented), validates it against the manifest literal, and
treats it solely as extension-origin/ID evidence—not a package-byte or profile measurement.

## 4. Profile selection and consent

The bridge never scans Chrome profiles. Version 1 supports only the dedicated profile in section
4.2. Section 4.1 documents a discovery/research gesture that cannot produce a Version 1 grant.

### 4.1 User-selected existing tab

The user navigates to the intended top-level YNAB tab and clicks the extension action. `activeTab`
may be used only to identify and validate that user-selected tab and to begin the foreground
permission ceremony. It is not sufficient for a successful Version 1 snapshot: the separately
disclosed optional host permission must be granted, the fixed observer must be registered for
`document_start`, and the selected tab must complete the controlled reload in section 5.1. There is
no activeTab-only or post-load best-effort snapshot mode. Because dynamic `document_start`
registration is origin-wide and an existing profile can contain unowned concurrent YNAB tabs, this
selection is research/probe UX only: every Version 1 private grant ultimately requires the dedicated
profile below. A future existing-profile mode needs a separate, provider-approved tab-contained
injection/cleanup contract.

### 4.2 Dedicated NAB profile

NAB launches Chrome with an absolute, NAB-owned `--user-data-dir`. The profile contains only the
bridge and YNAB login. Requirements:

- parent and profile directory mode `0700` on POSIX;
- one Chrome process lock per directory;
- never reuse the default Chrome data directory;
- the user enters password/MFA directly into YNAB;
- no remote-debugging TCP listener;
- explicit profile deletion at disconnect.

### 4.3 Consent record

```ts
type ConsentGrantV1 = {
  version: 1;
  grant_id: string;                    // random UUID, nonsecret
  plan_ref: string;                    // random UUID bound to exactly one protected plan record
  mode: "page-snapshot" | "browser-catalog" | "native-replay";
  extension_id: string;
  extension_package_fingerprint: string; // reviewed release SHA-256; see attestation below
  extension_attestation: {
    kind: "provider_managed_runtime_attestation";
    attestation_contract_id: string;
    loaded_package_sha256: string;
    evidence_sha256: string;
  };
  nab_binary_fingerprint: string;
  browser_profile_instance: string;    // random local reference, never a filesystem path
  ynab_account_fingerprint: string;    // salted local fingerprint
  private_budget_fingerprint: string;  // HMAC of private budget_id
  plan_fingerprint: string;            // HMAC of private budget_version_id
  capabilities: ("pending.list" | "pending.get" | "session.status")[];
  max_ynab_sync_age_seconds: number;    // 0..86_400; request may only tighten it
  retention: {
    normalized_cache: "memory_only";
    native_credential: "never";
    remove_optional_permissions_on_expiry: true;
  };
  data_destination: { kind: "local_process_only" };
  granted_at: string;                  // RFC 3339 UTC
  expires_at: string;
  provider_permission_reference: string;       // exact signed policy_id, not a selector/query
  disclosure_version: string;
};
```

Re-consent is required when mode, extension ID or signed-package fingerprint, NAB release identity, account/plan binding,
capabilities, retention, data destination, private API version, or disclosure text changes.

`native_credential` is literally `never` in every Version 1 mode. The capture-only research ceremony
may transfer one seed to the helper solely for bounded validation; the helper must erase it and all
reachable secret objects before replying and returns no usable session handle. Ephemeral retention
for replay requires the Version 2 transport/storage contract described in section 9.2.

`local_process_only` is the only Version 1 destination. It is a consent/use restriction and an enforceable receiver boundary, not a
technical claim that a process can never exfiltrate data after receipt. The broker releases records
only to the locally attested signed CLI binary named by the grant and never performs onward network
delivery; the CLI and its operator are obligated not to forward them. A named remote destination
requires a future protocol and provider policy that signs its processor, origin, privacy-policy
hash, retention, and disclosure. A local socket does not by itself make processing local.
Forwarding to any remote processor is outside a Version 1 grant.

`expires_at` MUST be later than `granted_at`, no more than 30 days later, and no later than the
verified provider policy's `expires_at`; therefore a timestamp-based retirement is always accurately
a consent expiry. If a newly installed signed release no longer contains the exact referenced
policy/hash, dispatch stops as `provider_permission_missing`; the consent record remains available
only for foreground renewal under a new compatible signed policy and no expired-consent tombstone is
forged. At consent expiry—or at the
first clock observation after expiry—the broker atomically refuses new pending calls, retires the
grant and protected binding through the deletion transaction in section 4.7, deletes the normalized
cache, cursors, reference key, and any native credential, and records only the nonsecret expired-grant
tombstone needed to return `CONSENT_EXPIRED` plus, for a dedicated profile, the encrypted local
ownership record needed to offer safe later cleanup. It removes optional Chrome permissions immediately when
a bound extension is available. Otherwise it stores the closed nonsecret pending-cleanup marker in
section 4.7; the next matching extension handshake must remove permissions and acknowledge the marker
before any grant bind or data access. Version 1 never logs out of YNAB, closes Chrome, or deletes a
profile merely because a grant expired: those effects exist only in the separately confirmed
`session.disconnect` request. Expiry leaves an isolated browser profile intact but unusable by NAB.
No cache or copied credential may outlive the grant.

### 4.4 Local and provider identity bindings

`plan_ref` is the grant field above: a random, nonsecret local identifier for one consent-bound
plan. It is neither a
public `plan_id` nor a private `budget_version_id`. The broker's protected binding record contains
the account, private-budget, and private-budget-version fingerprints and—only under a provider-defined
identity join—the public plan ID. Callers can select only the `plan_ref` present in their grant.

Version 1 creates no public-account binding: records carry their private account reference and
`public_account_id = null`, and the public-account filter is absent. A future profile may add a
provider-defined identity join and contract version. Names, balances, dates, and amounts never
establish an authority-bearing identity join.

The broker encrypts the grant/binding record with an OS-credential-store key and authenticates the
whole record; POSIX backing files, if any, live below a `0700` directory as `0600` nonsymlink regular
files. Each grant has a random 32-byte `identity_key`. Account, budget, and plan-version fingerprints
are unpadded base64url HMAC-SHA-256 over, respectively,
`"ynab-account-v1\0" || private_user_id`, `"ynab-budget-v1\0" || private_budget_id`, and
`"ynab-plan-v1\0" || private_budget_version_id`. The key and expected values are protected with the
binding record and sent only to the service worker in the bound grant context, never MAIN world.
Private IDs never appear in logs.

`provider_permission_reference` is not user authority. It must resolve to an unexpired,
release-pinned `ProviderAuthorizationPolicyV1` that NAB's release process created only after
verifying YNAB's written permission. The signed policy names the allowed modes, operations,
application/extension fingerprints, rate limits, effective/expiry dates, and source-document hash.
The broker verifies the policy signature against a key pinned in the signed binary; a missing,
forged, expired, or mismatched policy is `PROVIDER_PERMISSION_MISSING` before browser/network access.

```ts
type ProviderContractAssetV1 = {
  asset_id: string;
  kind:
    | "runtime_extension_attestation" | "recovery" | "session_revocation"
    | "exported_credential_revocation" | "web_build_getter"
    | "loaded_bytes_attestation" | "page_accessor" | "passive_success_signal"
    | "stateful_token_channel" | "native_device_registration" | "castle_or_exemption"
    | "cookie_rotation" | "credential_quiescence" | "tls_profile" | "provider_logout"
    | "required_cookie_scope"
    | "response_shape_registry" | "wire_json_schema" | "matched_pending_shape"
    | "mode_technical_contract";
  contract_schema: string;
  media_type: "application/jcs+json";
  canonical_jcs_base64url: string;      // exact UTF-8 JCS bytes, unpadded base64url
  sha256: string;                       // lowercase hash of decoded bytes
  status: "evidence_only" | "v1_executable";
};

type ProviderContractAssetIdentityV1 = {
  asset_id: string;
  kind: ProviderContractAssetV1["kind"];
  contract_schema: string;
  sha256: string;
};

type ProviderAuthorizationPolicyV1 = {
  schema: "nab.provider-authorization/1";
  policy_id: string;
  provider: "ynab";
  allowed_modes: ("page-snapshot" | "browser-catalog" | "native-replay")[];
  allowed_operations: ("session.status" | "pending.list" | "pending.get")[];
  nab_binary_fingerprints: string[];
  extension_ids: string[];
  extension_package_fingerprints: string[];
  runtime_extension_attestation_contracts: string[];
  minimum_chrome_version: string;
  api_version: string;
  catalog_schema: number;
  family_schema: number;
  budget_schema: number;
  minimum_refresh_interval_ms: number;
  maximum_requests_per_hour: number;
  maximum_retry_after_ms: number;
  rate_limit_scope: "application_installation";
  cache_limits: {
    catalog: { maximum_entities: number; maximum_jcs_utf8_bytes: number };
    family: { maximum_entities: number; maximum_jcs_utf8_bytes: number };
    budget: { maximum_entities: number; maximum_jcs_utf8_bytes: number };
  };
  parser_limits: {
    maximum_nesting_depth: number;
    maximum_object_properties: number;
    maximum_array_items: number;
    maximum_string_utf8_bytes: number;
  };
  effective_at: string;
  expires_at: string;
  provider_permission_document_sha256: string;
  session_revocation_contract: string | null;
  logout_action_contract: string | null;
  recovery_contracts: {
    reauthentication: string;
    permission_restore: string | null;
    provider_failure: string | null;
    ambiguous_session: string | null;
    ambiguous_read: string | null;
    ambiguous_commit: string | null;
  };
  mode_contracts: ProviderModeContractV1[];
  contract_assets: ProviderContractAssetV1[];
  signing_key_id: string;
  signature_algorithm: "Ed25519";
  signature: string;                    // unpadded base64url
};

type WebBuildIdentityV1 =
  | {
      kind: "provider_build_id";
      getter_id: string;
      expected_build_id: string;
    }
  | {
      kind: "loaded_asset_manifest";
      assets: { path: string; sha256: string }[];
      aggregate_sha256: string;
      loaded_bytes_attestation_contract: string;
    };

type OptionalDeviceInfoValueV1 =
  | { semantics: "required_literal"; value: string }
  | { semantics: "omitted" };

type DeviceInfoContractV1 = {
  id: "fresh_logical_device_uuid";
  device_name: OptionalDeviceInfoValueV1;
  device_type: OptionalDeviceInfoValueV1;
  device_os: OptionalDeviceInfoValueV1;
  device_os_version: OptionalDeviceInfoValueV1;
  browser_name: OptionalDeviceInfoValueV1;
  browser_version: OptionalDeviceInfoValueV1;
  ynab_app_version: OptionalDeviceInfoValueV1;
};

type DeviceHeaderProjectionV1 = [
  { name: "X-YNAB-Device-Name"; source: "device_name"; encoding: "encodeURIComponent_utf8" },
  { name: "X-YNAB-Device-Type"; source: "device_type"; encoding: "identity" },
  { name: "X-YNAB-Device-OS"; source: "device_os"; encoding: "identity" },
  { name: "X-YNAB-Device-OS-Version"; source: "device_os_version"; encoding: "identity" },
  { name: "X-YNAB-Device-App-Version"; source: "ynab_app_version"; encoding: "identity" }
];

type PageAdapterAssetsV1 = {
  observer: { path: "page-observer-v1.js"; sha256: string };
  identity_probe: { path: "page-identity-probe-v1.js"; sha256: string };
  snapshot_extractor: { path: "page-snapshot-extractor-v1.js"; sha256: string };
  aggregate_sha256: string;
};

type ProviderModeContractV1 =
  | {
      mode: "page-snapshot";
      contract_id: string;
      contract_sha256: string;
      web_build_identity: WebBuildIdentityV1;
      adapter_assets: PageAdapterAssetsV1;
      page_accessor_contract: { asset_id: string; sha256: string };
      matched_pending_shape_contract: string;
      passive_success_signal: string;
      passive_success_payload_schema: { asset_id: string; sha256: string };
      permitted_profile_bindings: ["dedicated_nab_profile"];
      permitted_extension_attestations: ["provider_managed_runtime_attestation"];
      runtime_attestation_contract_ids: [string];
    }
  | {
      mode: "browser-catalog";
      contract_id: string;
      contract_sha256: string;
      exact_realm_url: string;
      exact_catalog_url: string;
      web_build_identity: WebBuildIdentityV1;
      identity_probe_asset: { path: "browser-catalog-identity-probe-v1.js"; sha256: string };
      adapter_asset: { path: "browser-catalog-adapter-v1.js"; sha256: string };
      response_shape_registry_contract: string;
      matched_pending_shape_contract: string;
      catalog_operations: ["getInitialUserData", "syncCatalogData", "syncFamilyData", "syncBudgetData"];
      session_seed_semantics: "independent_device_seed";
      castle_semantics: "provider_browser_issuance_per_request";
      browser_castle_contract: string;
      stateful_token_channel_contract: string;
      device_info_contract: DeviceInfoContractV1;
      device_header_projection: DeviceHeaderProjectionV1;
      session_token_header: "X-Session-Token";
      api_version_header: { name: "X-YNAB-API-Version"; value: string };
      device_id_header: "X-YNAB-Device-Id";
      client_request_id_header: "X-YNAB-Client-Request-Id";
      castle_request_token_header: "X-Castle-Request-Token";
      origin_header: string;
      referer_header: string;
      x_requested_with: "XMLHttpRequest";
      content_type_header: "application/x-www-form-urlencoded; charset=UTF-8";
      accept_header: "application/json";
      fetch_credentials: "include";
      fetch_mode: "same-origin";
      fetch_redirect: "manual";
      request_body_max_bytes: number;
      response_body_max_bytes: number;
      accepted_response_media_types: ["application/json"];
      accepted_content_encodings: ("identity" | "gzip" | "br")[];
      maximum_initialization_requests: number;
      maximum_refresh_requests: number;
      permitted_profile_bindings: ["dedicated_nab_profile"];
      permitted_extension_attestations: ["provider_managed_runtime_attestation"];
      runtime_attestation_contract_ids: [string];
    }
  | {
      mode: "native-replay";
      contract_id: string;
      contract_sha256: string;
      exact_catalog_url: string;
      web_build_identity: WebBuildIdentityV1;
      identity_probe_asset: { path: "native-capture-identity-probe-v1.js"; sha256: string };
      response_shape_registry_contract: string;
      matched_pending_shape_contract: string;
      catalog_operations: ["getInitialUserData", "syncCatalogData", "syncFamilyData", "syncBudgetData"];
      native_device_registration_contract: string;
      device_info_contract: DeviceInfoContractV1;
      device_header_projection: DeviceHeaderProjectionV1;
      observed_web_app_version_header: OptionalDeviceInfoValueV1;
      castle_or_exemption_contract: string;
      cookie_rotation_contract: string;
      required_cookie_scope_contract: string;
      session_token_header: "X-Session-Token";
      api_version_header: { name: "X-YNAB-API-Version"; value: string };
      device_id_header: "X-YNAB-Device-Id";
      client_request_id_header: "X-YNAB-Client-Request-Id";
      castle_request_token_header: "X-Castle-Request-Token";
      origin_header: string;
      referer_header: string;
      x_requested_with: "XMLHttpRequest";
      content_type_header: "application/x-www-form-urlencoded; charset=UTF-8";
      accept_header: "application/json";
      redirect_semantics: "never_follow";
      session_token_capture:
        | { semantics: "eligible_request_header_remains_current" }
        | {
            semantics: "post_success_accessor";
            accessor_contract_id: string;
            accessor_asset: { path: "native-session-token-accessor-v1.js"; sha256: string };
          };
      passive_application_success_signal: string;
      passive_success_payload_schema: { asset_id: string; sha256: string };
      credential_quiescence_contract: string;
      tls_profile: string;
      exported_credential_revocation_contract: string;
      request_body_max_bytes: number;
      response_encoded_body_max_bytes: number;
      response_body_max_bytes: number;
      accepted_response_media_types: ["application/json"];
      accepted_content_encodings: ("identity" | "gzip" | "br")[];
      maximum_initialization_requests: number;
      maximum_refresh_requests: number;
      permitted_profile_bindings: ["dedicated_nab_profile"];
      permitted_extension_attestations: ["provider_managed_runtime_attestation"];
      runtime_attestation_contract_ids: [string];
    };
```

The signature covers RFC 8785 JCS of the complete object with `signature` omitted.
`provider_policy_sha256` everywhere in this protocol is
`lowerhex(SHA256(UTF8(JCS(complete ProviderAuthorizationPolicyV1))))`, including the `signature`
member. The immutable release asset's original bytes must already equal that complete JCS byte
sequence; reparsing/re-serializing noncanonical source is not a substitute. The full-policy digest
and the signature-omitted signing preimage are deliberately different and never interchanged. The set-like
string arrays (`allowed_modes`, `allowed_operations`, fingerprints, extension IDs,
runtime-attestation contract IDs, permitted profile/attestation values, and accepted
content encodings) are
duplicate-free and lexicographically sorted; fixed protocol tuples retain their specified order.
`contract_assets` is sorted by raw UTF-8 `asset_id`; asset IDs are nonempty printable ASCII at most
128 bytes and `contract_schema` is a nonempty printable ASCII schema identifier at most 256 bytes.
The set of `mode_contracts[].mode` equals `allowed_modes` exactly. Fingerprints and document hash are lowercase 64-digit
SHA-256 hex. Times are RFC 3339 UTC, `effective_at < expires_at`, and the numeric limits are safe
positive integers. A policy is usable only when `effective_at <= accepted_now < expires_at`;
accepted time uses section 4.7.5's trusted wall/monotonic discipline, and rollback/uncertainty fails
closed. The grant reference must equal this exact `policy_id`; the implementation never searches
for a closest or newest policy. Version 1 has no online revocation feed: an installed signed release
can invalidate a policy before its timestamp only by omitting its exact hash/ID from that release's
immutable policy set, which causes `PROVIDER_PERMISSION_MISSING`. It must not claim an unverified
remote revocation. Cache byte
limits measure RFC 8785 JCS UTF-8 for the complete modeled document cache, including tombstone
sentinels; entity limits count every modeled active or tombstoned identity. A missing limit is a
policy validation failure, never an implementation-selected default. This policy is
a local release-control representation of reviewed written permission, not proof of a server-side
read-only scope.

Exactly one mode contract must exist for each allowed mode and its `contract_sha256` must match the
canonical provider-reviewed technical contract stored with the signed release. The broker matches
every mode-specific field before granting consent; a free-form policy note cannot satisfy a gate.

Contract-reference resolution is field-path based, never suffix inference:

| Policy field path | Required asset kind / relation |
| --- | --- |
| `mode_contracts[*].contract_id` | `mode_technical_contract`; its asset hash equals `contract_sha256` |
| top-level `runtime_extension_attestation_contracts[*]` and per-mode `runtime_attestation_contract_ids[*]` | `runtime_extension_attestation`; the top-level list is the duplicate-free sorted union of the per-mode tuples |
| `recovery_contracts.*` when non-null | `recovery` |
| `session_revocation_contract` / `logout_action_contract` when non-null | `session_revocation` / `provider_logout` |
| `web_build_identity.getter_id` / `.loaded_bytes_attestation_contract` | `web_build_getter` / `loaded_bytes_attestation` |
| page `page_accessor_contract.asset_id` | `page_accessor`; asset hash equals the adjacent `sha256` |
| `passive_success_signal` and native `passive_application_success_signal` | `passive_success_signal` |
| either `passive_success_payload_schema.asset_id` | `wire_json_schema`; asset hash equals the adjacent `sha256` |
| any `matched_pending_shape_contract` | `matched_pending_shape` |
| any `response_shape_registry_contract` | `response_shape_registry` |
| `stateful_token_channel_contract` | `stateful_token_channel` |
| browser `browser_castle_contract` | `castle_or_exemption` |
| native `native_device_registration_contract` | `native_device_registration` |
| native `castle_or_exemption_contract` | `castle_or_exemption` |
| native `cookie_rotation_contract` / `credential_quiescence_contract` / `tls_profile` | `cookie_rotation` / `credential_quiescence` / `tls_profile` |
| native `required_cookie_scope_contract` | `required_cookie_scope` |
| native `session_token_capture.accessor_contract_id` when present | `page_accessor` |
| native `exported_credential_revocation_contract` | `exported_credential_revocation`; it cross-references the exact top-level session-revocation asset |

Every listed reference resolves to exactly one duplicate-free `contract_assets` entry; the decoded
bytes must be strict RFC 8785 JCS, hash to the listed digest, declare the same `contract_schema`, and
be accepted by a closed schema compiled into the signed broker and extension. Cross-asset references
are explicit asset IDs and form an acyclic graph. Every asset is referenced exactly once or by a
documented shared path above; unreferenced assets, duplicate IDs/digests, kind/schema mismatch,
unknown executable schemas, remote URLs, detached files, and runtime substitution invalidate the
policy. `provider_permission_document_sha256` alone hashes the external written-permission source and
is deliberately not executable. `evidence_only` assets can document research but can never satisfy
an execution gate.

This research snapshot defines no accepted `v1_executable` schema for the provider-specific runtime
attestation, passive success signal, token-channel, native-registration, Castle, cookie-rotation,
quiescence, required-cookie-scope, TLS, logout, revocation, response-shape attestation, or matched-pending representation
mechanisms. Those assets must therefore be `evidence_only`,
which keeps every private mode or optional logout that depends on them disabled. A provider-reviewed
future protocol revision must add each complete discriminated schema and conformance vectors before
changing that status; merely adding a signed opaque label is insufficient.

Policy bootstrap parsing uses binary-compiled limits, not the untrusted policy's own parser limits:
the raw UTF-8 policy is at most 8,388,608 bytes, nesting at most 32, any object at most 4,096 members,
any array at most 1,024 elements, any ordinary string at most 349,526 UTF-8 bytes, and
`contract_assets` at most 64 entries. Before allocating or base64url-decoding an asset, its encoded
string is checked against 349,526 ASCII bytes; decoded canonical JCS is at most 262,144 bytes per
asset and 4,194,304 bytes in aggregate. The bootstrap parser rejects invalid UTF-8, duplicate keys,
non-I-JSON numbers, lone surrogates, invalid base64url, and trailing bytes. It then verifies policy
canonical form/signature, asset hashes/canonical form, graph bounds, and only afterward applies the
smaller signed runtime parser limits. No compressed or recursive asset encoding is accepted.

For both catalog contracts, `exact_catalog_url` is the literal ASCII serialization
`https://app.ynab.com/api/v1/catalog`. For browser-catalog, `exact_realm_url` is a provider-signed
absolute HTTPS URL whose serialized origin is exactly `https://app.ynab.com`; it has no credentials,
query, or fragment, and its path is absolute and already percent-encoded canonically. Its
`origin_header` is exactly `https://app.ynab.com` and `referer_header` is exactly
`exact_realm_url`. For native-replay, `origin_header` and `referer_header` are exact provider-signed
ASCII values satisfying the same no-credentials/no-fragment URL grammar and the origin value is
exactly `https://app.ynab.com`. In both branches `api_version_header.value` equals the policy's
`api_version` byte-for-byte. Header-name literals are compared ASCII case-insensitively on receipt,
but the adapter emits the spelling shown by the type. Values are compared byte-for-byte; leading or
trailing optional whitespace, duplicate singleton headers, obsolete folding, or an unlisted
credential/security/version header fails before dispatch. The browser adapter invokes Fetch with
the exact credentials/mode/redirect discriminators above, sets only the explicitly constructible
headers, supplies `referer_header` through Fetch's `referrer` option, and relies on Chrome to emit
Origin, Cookie, and transport-managed headers. A provider-managed realm contract must prove those
browser-controlled values have the signed semantics. It never constructs a target from the realm
URL, follows a redirect, or accepts a response from another URL.

Every direct, non-URL HTTP field value governed by this protocol uses the closed
`nab.http-field-value/1` grammar: 1 through its field-specific byte ceiling, ASCII bytes
`0x21..0x7e` only. Space, HTAB, DEL, NUL, every C0/C1 control, non-ASCII/obs-text, CR/LF, and any
folding sequence are rejected. The rule applies when validating signed policy literals and again
when capturing/constructing `X-Session-Token`, API/app-version, device ID, client-request ID, and
Castle/security material. Device metadata first passes its Unicode body-field grammar, then its
specified `encodeURIComponent_utf8` projection must satisfy this ASCII grammar before becoming a
header. Origin/referrer values instead satisfy the stricter canonical URL grammar above. Header
names remain fixed literals. A provider requirement outside this grammar needs a new reviewed
protocol revision; implementations never rely on Fetch/HTTP libraries to trim, normalize, fold, or
reject a structurally accepted value.

`device_info_contract` closes the bootstrap body. `id` is the same fresh logical-device UUID used in
the required device-ID header. Every `required_literal` value is a Unicode scalar sequence of
1..256 UTF-8 bytes and appears as the exact corresponding `DeviceInfo` field; every `omitted` field
is absent, not null/empty. The seven fields above are exhaustive. The fixed header-projection tuple
is not policy-extensible: emit a device metadata header if and only if its source field is required.
Identity encoding copies bytes unchanged; `encodeURIComponent_utf8` is ECMAScript
`encodeURIComponent` over the scalar string (UTF-8, uppercase hex escapes) with lone surrogates
already rejected. Browser name/version remain body-only. The service worker and MAIN adapter
independently reconstruct this exact object/header projection before comparing the form digest; a
truthful value change requires a newly signed policy, never a runtime guess or copied browser label.

The top-level `session_revocation_contract` names the provider proof that the dedicated-
profile logout invalidated the current server session; null means no such confirmation is available.
The native mode's distinct `exported_credential_revocation_contract` names proof that every copied
cookie/session-token aggregate from that grant is unusable after revocation. It is nonempty only in
the native mode contract and must explicitly cite the same top-level session-revocation contract;
the two identifiers are not interchangeable. A native-replay disconnect may report server
revocation `confirmed` only when the top-level field is non-null and one response satisfies both
signed contracts. Otherwise it is `not_confirmed` even if ordinary browser logout succeeded.

A page/realm build is not identified by a guessed bundle filename or by refetching a URL that may now
serve different bytes. `provider_build_id` is usable only when the signed contract names a read-only
getter whose value the running document itself cryptographically binds to all relevant loaded assets.
For `loaded_asset_manifest`, entries are nonempty, unique, and sorted by raw UTF-8 path; each path is
an absolute same-origin URL path without query/fragment and each hash is lowercase SHA-256. The
aggregate is
`SHA256(UTF8("ynab-loaded-assets-v1\0") || for each entry: u32be(pathBytes.length) || pathBytes ||
hashBytes)`, where `pathBytes` is exact UTF-8 and `hashBytes` is the 32 decoded bytes of the
lowercase-hex `sha256` value (not the 64 ASCII hex bytes). Its `loaded_bytes_attestation_contract` must prove the bytes actually loaded by this
document, not a later network/cache fetch, and bind the proof to `document_id`. If neither mechanism
is supplied and independently validated, page snapshot returns `PROTOCOL_CHANGED` before extraction;
the current asset-path/hash research inventory alone is not runtime build attestation.
Every mode's identity probe uses only its exact packaged path/hash (the page-snapshot
`adapter_assets.identity_probe`, or the other modes' `identity_probe_asset`) and validates that
mode's `web_build_identity` before
returning a fingerprint. `web_build_fingerprint` is exactly `"id:" + expected_build_id` for the first branch or
`"sha256:" + aggregate_sha256` for the second; both are nonempty and at most 256 UTF-8 bytes.
The three page assets are exact packaged basenames with lowercase SHA-256 file hashes. Their
aggregate is computed in the tuple order shown as
`SHA256(UTF8("nab-page-adapter-assets-v1\0") || for each of [observer, identity_probe,
snapshot_extractor]: u32be(pathBytes.length) || pathBytes || decodedHash32)`, where each
`decodedHash32` is the 32 bytes decoded from lowercase hex, not its ASCII spelling. The signed accessor descriptor hash identifies canonical closed JSON that names every
active-user/budget/version getter, transaction collection/index contract, account/payee lookup,
transaction-child lookup, sync/unsaved-status accessor, arity, optionality, return schema, and
cardinality used by those files. Missing descriptor bytes, a hash mismatch, or any required accessor
not expressible by that descriptor leaves page-snapshot gated; an implementation never invents a
property path from prose.
The following immutable product ceilings are applied before a policy signature can authorize use:

```text
180,000 <= minimum_refresh_interval_ms <= 86,400,000
maximum_requests_per_hour         <= 1,000
maximum_retry_after_ms            <= 604,800,000
request_body_max_bytes            <= 1,048,576
response_encoded_body_max_bytes   <= 67,108,864
response_body_max_bytes           <= 67,108,864
cache maximum_entities            <= 100,000 per document
cache maximum_jcs_utf8_bytes      <= 67,108,864 per document
parser maximum_nesting_depth      <= 64
parser maximum_object_properties  <= 4,096
parser maximum_array_items        <= 100,000
parser maximum_string_utf8_bytes  <= 1,048,576
```

All otherwise unstated lower bounds are one except that body/cache byte limits are at least 1,024,
parser depth at least 8, and `maximum_requests_per_hour` is at least 5 for a catalog/native mode. A native mode's
encoded ceiling is no larger than its decoded ceiling. For the fixed choreography in this version,
`maximum_initialization_requests` MUST equal `5` and `maximum_refresh_requests` MUST equal `3` for
both catalog/native contracts; a missing-family run conservatively leaves the reserved fifth/third
slot unused. Both values must be no greater than `maximum_requests_per_hour`. Page snapshot has no
request-burst fields and its bind values are fixed zero. Values outside these ranges reject the
policy even when correctly signed; implementations never allocate directly from an unchecked
policy value.

`request_body_max_bytes` counts the final UTF-8 form entity after form/percent encoding and before
HTTP content encoding, exactly as defined by the core protocol. For `browser-catalog`, grant creation additionally requires
`max_ynab_sync_age_seconds >= ceil(minimum_refresh_interval_ms / 1000)`; otherwise the scheduler
could never make a result usable without violating the signed cadence and consent must fail.

Consent capabilities and every policy set-array are duplicate-free and sorted by raw UTF-8 bytes.
Allowed modes/operations, extension IDs/reviewed fingerprints, every mode's permitted profile/
attestation set, and accepted encodings are nonempty. Each mode's
`runtime_attestation_contract_ids` is nonempty iff that mode permits managed attestation and is
otherwise exactly empty. `runtime_extension_attestation_contracts` is the duplicate-free union of
those arrays. Every grant includes `session.status`, and its
capabilities are a subset of the signed allowed operations. Version 1's literal
`remove_optional_permissions_on_expiry: true` means expiry
always attempts removal or creates the authenticated cleanup marker described below; there is no
silent retain-permissions variant.

Chrome Native Messaging proves the caller origin/extension ID to Chrome's launch decision; it does
not give the native host a measurement of the running extension package bytes, loaded package path,
or Chrome profile. Consequently `extension_package_fingerprint`, extension version, and profile
instance reported in hello are never accepted as self-attestation. Hashing an installed directory
also proves only those files, not that the caller loaded them. `provider_managed_runtime_attestation`
is therefore a separately reviewed, signed mechanism that must cryptographically bind the current
Native port challenge, extension origin, attested Chrome process/start identity, selected profile,
and loaded package digest; its exact contract ID must appear in
`runtime_extension_attestation_contracts`. No such generic Chrome mechanism is currently verified,
so every Version 1 private mode remains gated until the provider supplies that mechanism. The
consent's dedicated-profile kind and managed-attestation contract must equal the selected mode's
fixed values. The broker never treats a fingerprint repeated in
`NativeHelloV1` as independent evidence.

Grant-to-policy equality is branch-exact. `grant.extension_id` is a member of
`policy.extension_ids`; `grant.extension_package_fingerprint` is a member of
`policy.extension_package_fingerprints`; and the grant's binary fingerprint is a member of the
policy binary set. For the required `provider_managed_runtime_attestation`,
`loaded_package_sha256`, `grant.extension_package_fingerprint`, and the reviewed policy member are
equal; `attestation_contract_id` belongs to both the selected mode's and policy's runtime-contract
sets; and fresh evidence validates under that exact contract and hashes to `evidence_sha256`.
Every SHA-256 field in this paragraph is lowercase 64-hex. Any disagreement is
`PROVIDER_PERMISSION_MISSING`, not a request to choose the closest policy entry.

### 4.5 Opaque private references

Each grant owns a random 32-byte `reference_key` stored with the protected binding. The extension
receives it only in memory over the bound Native channel and derives references as:

```text
private_entity_ref = "ynp1_" || base64url(HMAC-SHA-256(
  reference_key, len(plan_ref) || plan_ref || len("transaction") || "transaction" || len(raw_id) || raw_id))
private_account_ref = "yna1_" || base64url(HMAC-SHA-256(
  reference_key, len(plan_ref) || plan_ref || len("account") || "account" || len(raw_id) || raw_id))
```

Each `len` is an unsigned 32-bit big-endian UTF-8 byte length. Raw IDs must be nonempty Unicode
scalar sequences at most 512 UTF-8 bytes. References are plan/grant scoped, stable only until the
grant is deleted, and never accepted by a public API command. `pending.get` compares a supplied
reference in constant time against freshly derived references in the current bound entity map; it
does not reverse the HMAC. Re-consent rotates the key and invalidates every prior reference.

### 4.6 Trusted connect and renewal ceremony

`nab web connect`/renewal is a foreground broker UI, not a broker socket operation and not an agent
capability. Its state machine is closed:

```text
IDLE -> POLICY_VALIDATED -> PROFILE_INTENT_COMMITTED -> PROFILE_READY
     -> HELLO_ATTESTED -> PREPARATION_ARMED -> BROWSER_PERMISSION_GRANTED
     -> MODE_TARGET_PREPARED -> CANDIDATE_KEYS_STAGED -> IDENTITY_PROBED
     -> DISCLOSURE_SHOWN -> USER_APPROVED
     -> CANDIDATE_COMMITTED -> CANDIDATE_BOUND -> AUTHORITY_ACTIVATED
     -> ACTIVATION_ACKED -> READY_OR_GATED
```

1. Verify the signed provider policy, binary, extension ID/package, requested mode, version tuple,
   and mode contract before opening browser access.
2. Require the dedicated NAB profile; Version 1 never scans or binds an ordinary Chrome profile.
   Generate provisional preparation/grant/plan IDs and an exact random child basename under the
   installer-recorded profile parent. On first connect, commit `profile_phase:"planned"` with the
   absolute path and saved parent identity before exclusive directory creation; after creation,
   record its directory identity and `directory_created` before launch; after launch, record the
   exact Chrome PID/start identity and `chrome_launched` before accepting a browser port. A crash in
   any phase leaves this encrypted intent and publishes no sockets: absent planned path can be
   cleared, while an existing path without a committed identity is never deleted automatically and
   requires the trusted cleanup UI. Renewal copies the exact active profile ownership tuple instead
   of creating a directory and first drains its old scheduler/data host and every permit to a
   definitive outcome.

   The extension action then opens the hello-only candidate-probe port carrying the pre-mutation
   target/profile instance. The broker validates the host and fresh attestation against the saved
   Chrome/profile ownership, generates and commits the exact page registration-scope or catalog
   preparation-scope cleanup obligation plus those fields in `extension_bound` with
   `browser_mutation:"not_started"`, and grants no page access. It commits
   `browser_mutation:"may_have_occurred"` immediately before sending `preparation_armed`; only then
   may permission be requested or any page/realm mutation occur.
   For `page-snapshot`, mode preparation then registers the signed passive observer for future
   `document_start`, asks the user to reload the same selected tab, and waits for the new top-level
   document to finish the observed bootstrap/backfill. Only afterward does it reacquire and validate
   the same tab's new `document_id`, frame 0, exact origin, and profile context and create
   `BrowserTargetBindingV1`, and atomically enrich the preparation intent with its document-bound
   observer cleanup data before probing. Candidate keys/probe/consent are created against that post-reload
   document only; the pre-reload document is never bound. Failure, tab replacement, or another
   navigation restarts mode preparation. This branch requires temporary host permission because an
   `activeTab` grant cannot establish a pre-load observer across reload.
3. Reuse the intent's exact provisional `grant_id` and `provisional_plan_ref` as the candidate
   `grant_id` and `plan_ref`; generate only `identity_key` and `reference_key` in broker memory,
   but send only the candidate identity key to the service worker for the fixed non-mutating identity probe. The
   reference key remains broker-only until a grant is committed and a later data-port bind occurs.
   The worker computes fingerprints from
   bounded raw user/budget/budget-version IDs and erases the raw IDs. Names are shown for human recognition
   but never establish identity.
4. Show the candidate `plan_ref`, mode, exact plan/account display, capabilities, local/remote data
   use, retention, expiry, unsupported-interface/provider-policy status, extension/binary identities,
   and revocation limits.
5. The trusted OS dialog records explicit approval of that exact candidate
   `plan_ref`; approval cannot be copied to a regenerated identifier. Atomically commit the approved
   candidate grant+binding in the non-active candidate slot from section 4.7 or commit nothing.
6. The probe receipt says only `candidate_committed`; it is not a success result for `nab web
   connect`. Promote that same still-open, target-bound probe port into the candidate bind; Version 1
   never accepts a later standalone data port. The old renewal port was already drained before
   preparation. Its ack must have proved either no request was in flight or a definitive outcome was
   durably recorded; an ambiguous ack destroys the old logical device/cache, records the ambiguity,
   and prevents preparation. No old permit or scheduler run may survive the swap. After the candidate bind succeeds, one atomic
   authority-index update activates it and retires the old grant. The broker then sends
   `grant_activated`; the worker accepts no request/key use before it and must ack it. If candidate
   bind fails after browser mutation, the broker runs the rollback above and retires the old drained
   grant; it never restores authority to an invalidated target. Installation-wide rate history is
   unchanged.
   If the activation commit succeeds but its message/ack is lost, the new grant remains the sole
   authority but has no usable browser channel, the old grant is never restored, and connect reports
   `BROWSER_UNAVAILABLE`; foreground renewal is required. This is not reported as candidate rollback.
7. Only after the activation ack can `nab web connect` report grant creation. The final state is `ready` only if the selected mode's
   separate completeness/execution gate passes; otherwise report the exact gated state and do not
   dispatch a private request.

Any cancel, navigation, identity/version mismatch, missing policy, permission denial, timeout, or
partial commit enters rollback: atomically convert a possibly-mutated preparation to the cleanup
marker, revoke the candidate grant, zero candidate keys, perform exact observer/permission cleanup
when possible, close new ports, and close—but do not delete—a newly created dedicated profile. A
pre-mutation intent is simply cleared. Once browser mutation may have occurred, renewal rollback
also retires the drained old grant and requires new consent after cleanup. Renewal repeats every step and atomically replaces the old grant only
after the new one is fully committed; then it deletes the old reference key/cache. There is no silent
mode downgrade or fallback.

Version 1 permits exactly one active grant installation-wide and at most one connect/renewal
candidate. Starting `connect` while an active grant exists is necessarily renewal. This bound is
part of the durable schema below, not merely a UI convention.

`minimum_chrome_version` is not compared as text. Policy validation requires exactly four
dot-separated ASCII decimal components, each `0|[1-9][0-9]*`, each at most `2^31-1`, and no leading
zeroes; the running Chrome version is normalized to the same four-component form and compared
lexicographically as integer tuples. Any other grammar or missing component rejects the policy.
The immutable product floor is `106.0.0.0` when page-snapshot or browser-catalog is allowed because
Version 1 relies on document-ID-targeted scripting/results, and `132.0.0.0` when native-replay is
allowed because capture relies on the pinned partition-key behavior. A policy minimum below the
maximum floor of its allowed modes is invalid even when signed; the running browser must satisfy the
same maximum.

Probe display labels are untrusted convenience text, never binding evidence. Each must be a nonempty
Unicode scalar sequence at most 256 UTF-8 bytes. Reject NUL, C0/C1 controls, Unicode `Bidi_Control`
characters, and lone surrogates. The trusted OS dialog renders them only as inert literal text (no
HTML/Markdown/ANSI), inside an explicit bidirectional-isolation container, with fixed surrounding
labels showing the opaque local plan reference. Account/plan display labels are forbidden from all
logs and telemetry.

### 4.7 Version 1 durable local-state contract

This subsection is the complete broker-owned mutable-disk allowlist for `nab-ynab-bridge/1`; the
separately authenticated, one-shot OS profile-deletion job is also allowed only in the closed form
defined in section 4.7.6. A dedicated Chrome profile is an explicitly user-approved browser data
root, not a broker record: its cookies, provider storage, and Chrome-managed files are outside this
allowlist and can exist only under the section 4.2 dedicated-profile lifecycle. The browser catalog
entity maps, knowledge cursors, pending indexes, page projections, captured credentials, Castle
material, and provider bodies are not durable state. The signed provider policy is an immutable
release asset and is verified from its original bytes; it is not converted into mutable authority.
No implementation may add another durable record without changing this protocol version.

#### 4.7.1 Storage root, ownership, and OS keys

The signed installer creates one installation ID (canonical lowercase UUIDv4), one absolute state
root, and one absolute dedicated-profile parent obtained from operating-system per-user application-
data APIs, never from a caller path or unresolved environment variable. It records their exact
directory identities together with the installed-component and supported-Chrome identities in the
closed `InstallationMetadataV1` record below. On POSIX, both final roots are owned by the effective
user, have mode `0700`, are opened component-by-component with directory handles and no-follow
semantics, and the state root contains only owner-owned nonsymlink regular files of mode `0600`. The
trusted-ancestor rule in section 7.1 also applies. Windows uses current-user directories whose
explicit DACL grants full access only to that user and `SYSTEM`, denies inherited write access, and
rejects reparse points. Failure to prove these properties disables every private mode.

The OS credential store contains exactly these Version 1 items:

| Purpose | Size/lifetime | Credential-store readers |
| --- | --- | --- |
| `installation_metadata` | one immutable strict-JCS `InstallationMetadataV1`; installation to uninstall | signed installer creates; signed broker reads |
| `state_manifest` | strict JCS value; installation to uninstall | signed broker only |
| `state_seal_key` | 32 random bytes; installation to uninstall | signed broker only |
| `rate_state_key` | 32 random bytes; installation to uninstall | signed broker only |
| `pairing_credential` | one fixed-account strict-JCS credential containing key, epoch, generation, and authorized CLI fingerprint; pairing to disconnect/re-pair | signed CLI and broker only |
| `replay_state_key` | 32 random bytes, named by `pairing_epoch`; pairing to disconnect/re-pair | signed broker only |
| `host_broker_key` | 32 random bytes; installed host pairing to uninstall | signed broker and pinned native host only |
| `grant_record_key` | 32 random bytes, one item named by `grant_id`; candidate creation through retirement cleanup | signed broker only |
| `profile_cleanup_helper_private_key` | 32-byte X25519 private key; install through uninstall | pinned cleanup helper only |
| `profile_cleanup_broker_auth_key` | 32 random bytes; installation through uninstall | signed broker and pinned cleanup helper only |

Key bytes are generated by the OS CSPRNG and are never derived from one another, exported, backed up,
or synchronized. On macOS each symmetric item is a generic-password item with
`kSecUseDataProtectionKeychain = true`, `kSecAttrSynchronizable = false`, and
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Reader partitioning uses distinct signed-target
Keychain access groups whose entitlements contain exactly the reader set in the table; this design
does not combine the data-protection Keychain with legacy `SecAccess` trusted-application ACLs.
The cleanup helper itself generates its X25519 secret in its helper-only access group on first
install and returns only the public key to the signed installer. The installer challenge-tests that
exact helper instance and pins the public key, helper signature, and key ID in immutable installation
metadata. The broker can wrap a per-job key to that public key but cannot read the private key.
Other platforms must provide equivalent current-user, device-local, executable-identity access
control; otherwise standing bridge modes are unsupported. Services are
`io.nab.ynab-bridge.<purpose>.v1`; accounts are the installation ID followed, where applicable, by
the canonical epoch/grant/job ID. The pairing exception is exactly one singleton item with service
`io.nab.ynab-bridge.pairing-credential.v1` and account equal to `installation_id`. Direct lookup by
that complete pair must yield zero or one item; enumeration, multiple matches, or a third value is
corruption. The CLI is read-only with respect to this item and never selects or enumerates an epoch.
Key names contain no provider ID.

The production metadata item uses service `io.nab.ynab-bridge.installation-metadata.v1` and fixed
account `current`; development uses a distinct service. Direct lookup must return exactly one item.
The ordinary broker has no metadata write path. Its first action is to parse and validate that item,
reopen the recorded roots and executables by trusted handles, and require every saved identity,
digest, signature/publisher result, and supported Chrome product predicate to match. The item is
strict JCS at most 32,768 UTF-8 bytes, depth at most 5, at most 64 total object properties, at most
eight Chrome products, paths at most 4,096 UTF-8 bytes, and every other string at most 512 UTF-8
bytes. A missing/duplicate item, bound excess, invalid field, identity mismatch, or digest mismatch
is fatal local corruption. Version 1 supports no in-place metadata or installed-component update:
a component, path, helper key, profile parent, Chrome product/publisher designation, or metadata
change requires the trusted uninstall/cleanup ceremony followed by a new installation ID and fresh
consent. An ordinary update cannot silently rewrite the root of trust.

The signed installer, not an ordinary broker launch, performs first-install bootstrap. It creates
and challenge-tests the helper key, creates the roots and installed artifacts, writes and re-reads
the one metadata item, then writes the initial empty authority index and rate record, flushes them,
and creates `state_manifest` last. The manifest's `installation_metadata_sha256` is the lowercase
SHA-256 of the exact metadata JCS bytes and must match on every startup.
The initial authority index has `generation = 1` and literal null for `active`, `candidate`,
`browser_preparation`, `expired_tombstone`, `browser_cleanup_marker`, `capture_cleanup_intent`, and
`retired_profile`; no authority-adjacent file, credential item, Native host, scheduler, reservation,
or cleanup job may exist.
That first manifest has `last_pairing_generation = 0`, null active/replay/transition/retirement
pairing fields, and the fixed pairing credential is absent. No other bootstrap combination is valid.
If the manifest is absent but metadata or any other Version 1 key/file remains, bootstrap is incomplete: the broker
does not infer a fresh installation or reset counters. The installer may diagnose the mismatch but,
because Version 1 defines no backup/restore format, only explicit uninstall can return the product to
a reinstallable state. Once present, a missing manifest key, metadata/manifest digest or installation-ID
mismatch, or non-atomic credential-store implementation is fatal local corruption.

#### 4.7.2 Canonical envelopes and commit point

All schemas in this subsection are closed: unknown/missing fields, duplicate JSON keys, non-JCS
numbers, invalid UTF-8, or a non-canonical UUID/base64url/time value reject the record. Persisted
timestamps are RFC 3339 UTC with exactly three fractional digits. Safe integers are decimal JSON
integers in `0..2^53-1`. An envelope is serialized as RFC 8785 JCS with no BOM, newline, or trailing
byte.

```ts
type InstalledExecutableIdentityV1 = {
  role: "broker" | "native_host" | "profile_cleanup_helper";
  absolute_path: string;
  file_identity: string;                // platform volume/file identity
  owner_identity: string;
  sha256: string;                       // lowercase digest of installed bytes
  platform_signature_identity: string;
};

type SupportedChromeProductIdentityV1 = {
  platform: "macos" | "windows" | "linux";
  product_id: string;                   // bundle/package/product ID from the OS verifier
  publisher_identity: string;
  executable_absolute_path: string;
};

type InstallationMetadataV1 = {
  schema: "nab.installation-metadata/1";
  generation: 1;
  installation_id: string;
  installed_at: string;
  state_root_absolute_path: string;
  state_root_directory_identity: string;
  state_root_parent_directory_identity: string;
  profile_parent_absolute_path: string;
  profile_parent_directory_identity: string;
  executables: [
    InstalledExecutableIdentityV1 & { role: "broker" },
    InstalledExecutableIdentityV1 & { role: "native_host" },
    InstalledExecutableIdentityV1 & { role: "profile_cleanup_helper" }
  ];
  native_host_manifest_absolute_path: string;
  native_host_manifest_sha256: string;
  cleanup_helper_public_key_id: string;
  cleanup_helper_x25519_public_key: string; // decoded 32 bytes, unpadded base64url
  cleanup_helper_challenge_sha256: string;
  supported_chrome_products: SupportedChromeProductIdentityV1[]; // 1..8, canonical sort
};

type LocalRecordTypeV1 =
  | "authority_index" | "grant_binding" | "replay_state" | "rate_state";

type LocalRecordPointerV1 = {
  record_type: LocalRecordTypeV1;
  generation: number;                  // >= 1; immutable slot generation
  relative_name: string;               // protocol-generated basename, never caller input
  key_id: string;                      // opaque credential-store item ID
  envelope_sha256: string;             // lowercase SHA-256 hex of exact envelope bytes
};

type PairingCredentialV1 = {
  schema: "nab.pairing-credential/1";
  installation_id: string;
  pairing_generation: number;          // safe integer >= 1
  pairing_epoch: string;               // canonical lowercase UUIDv4
  pairing_key: string;                 // decoded length 32, unpadded base64url
  authorized_cli_fingerprint: string;  // lowercase SHA-256 release fingerprint
};

type PairingCredentialIdentityV1 = {
  pairing_generation: number;
  pairing_epoch: string;
  authorized_cli_fingerprint: string;
  credential_sha256: string;
};

type PairingTransitionV1 = {
  schema: "nab.pairing-transition/1";
  reason: "initial_pair" | "rotate" | "trusted_recovery";
  expected_item_before: PairingCredentialIdentityV1 | null;
  next: PairingCredentialIdentityV1;
  next_replay_state: LocalRecordPointerV1 & { pairing_epoch: string };
  prepared_at: string;
};

type PairingRetirementV1 = {
  schema: "nab.pairing-retirement/1";
  reason: "disconnect";
  credential: PairingCredentialIdentityV1;
  started_at: string;
};

type LocalAeadHeaderV1 = {
  schema: "nab.local-aead-envelope/1";
  installation_id: string;
  record_type: "authority_index" | "grant_binding" | "replay_state";
  key_id: string;
  generation: number;
  created_at: string;
  nonce: string;                       // 24 random bytes, unpadded base64url
};

type LocalAeadEnvelopeV1 = LocalAeadHeaderV1 & {
  ciphertext: string;                  // ciphertext || 16-byte tag, unpadded base64url
};

type LocalMacEnvelopeV1 = {
  schema: "nab.local-mac-envelope/1";
  installation_id: string;
  record_type: "rate_state";
  key_id: string;
  generation: number;
  created_at: string;
  payload: RateStateV1;
  auth_tag: string;                    // 32-byte HMAC, unpadded base64url
};

type PendingDeletionIntentV1 = {
  deletion_id: string;                 // UUIDv4
  kind: "grant_record" | "replay_state" | "obsolete_slot";
  key_id: string | null;
  relative_names: string[];            // 0..8 unique, lexicographically sorted basenames
  queued_at: string;
};

type LocalStateManifestV1 = {
  schema: "nab.local-state-manifest/1";
  installation_id: string;
  installation_metadata_sha256: string;
  generation: number;                  // >= 1, increments exactly once per commit
  authority_index: LocalRecordPointerV1;
  last_pairing_generation: number;     // starts 0; never decreases/reuses
  active_pairing: PairingCredentialIdentityV1 | null;
  replay_state: (LocalRecordPointerV1 & { pairing_epoch: string }) | null;
  pairing_transition: PairingTransitionV1 | null;
  pairing_retirement: PairingRetirementV1 | null;
  rate_state: LocalRecordPointerV1;
  pending_deletions: PendingDeletionIntentV1[];
};
```

For a decoded `PairingCredentialV1`, `credential_sha256` is
`lowerhex(SHA256(UTF8("nab-pairing-credential-v1\0") || UTF8(JCS(credential))))`. The credential's
installation ID and all identity fields must agree; the key decodes to exactly 32 bytes. The closed
manifest states are:

- unpaired steady state: `active_pairing`, `replay_state`, `pairing_transition`, and
  `pairing_retirement` are null and the fixed item is absent;
- paired steady state: active identity, replay epoch/key/plaintext, and the one fixed item agree,
  both transition fields are null, and `last_pairing_generation` equals the active generation;
- prepared transition: retirement is null; old active/replay remain unchanged (or both are null for
  initial pair); `next.pairing_generation == last_pairing_generation + 1`, its epoch is fresh, the
  next replay pointer/key/plaintext agree and contain exactly an empty replay entry array, and the
  fixed item is either exactly `expected_item_before` or exactly `next`;
- retirement: active pairing and transition are null, retirement names the former identity,
  replay still names that former epoch, and the fixed item is either that exact credential or absent.

Transition and retirement are mutually exclusive. In steady unpaired state generation may remain
positive; it never resets. A fixed item with a third digest/identity, multiple direct-lookup results,
an active/replay epoch disagreement, or any other combination is authenticated corruption. No CLI
or browser socket is published in a transition, retirement, mismatch, or duplicate-item state.
`PairingTransitionV1.next_replay_state` is an authoritative referenced slot for orphan detection even
though it is not yet the active replay pointer.

`InstallationMetadataV1.executables` has the literal role order shown above; each role appears once.
`supported_chrome_products` is nonempty, duplicate-free, and raw-UTF-8 sorted by
`(platform, product_id, publisher_identity, executable_absolute_path)`. Every SHA field is lowercase
64-hex; the helper public key decodes to exactly 32 bytes. `installation_metadata_sha256` is
`lowerhex(SHA256(UTF8(JCS(InstallationMetadataV1))))`. The state-root and profile-parent paths are
different, neither contains the other, and all saved parent/root identities are rechecked before
use. A running Chrome parent is acceptable only when the OS verifier returns one exact product/
publisher/path tuple from this record; the provider policy independently constrains the minimum
Chrome version and extension/runtime contract but carries no publisher selector.

`authority_index` uses `state_seal_key`, each `grant_binding` uses its named per-grant key,
`replay_state` uses the key for its exact pairing epoch, and `rate_state` uses `rate_state_key`.
The encrypted algorithms are XChaCha20-Poly1305-IETF with a 32-byte key and 24-byte random nonce.
AAD is the byte concatenation
`UTF8("nab-local-aead-envelope-v1\0") || UTF8(JCS(LocalAeadHeaderV1))`; plaintext is JCS of the
closed record type. The MAC is
`HMAC-SHA-256(rate_state_key, UTF8("nab-local-mac-envelope-v1\0") ||
UTF8(JCS(LocalMacEnvelopeV1 without auth_tag)))`. Decryption/MAC comparison is constant-time with
respect to the tag. A nonce collision with any retained envelope under the same key is regenerated;
every write obtains fresh CSPRNG bytes and never copies a prior nonce.

Slot basenames are exactly `authority-index.<20-digit-generation>.aead`,
`grant.<lowercase-grant-uuid>.00000000000000000001.aead`,
`replay.<lowercase-pairing-epoch>.<20-digit-generation>.aead`, or
`rate.<20-digit-generation>.mac`. Every `relative_name`/pending-deletion basename is ASCII, at most
200 bytes, contains no slash/backslash/NUL, and matches one of those complete grammars; it is never
an arbitrary relative path. Generation is zero-padded ASCII decimal and agrees in pointer,
envelope, and plaintext. Grant records are immutable generation 1. Authority/replay plaintext is at
most 256 KiB/8 MiB respectively; a rate envelope is at most 8 MiB. Exceeding a bound fails closed and
does not evict live authority, an unexpired replay nonce, rate reservation, or deadline.

`pending_deletions` is unique by `deletion_id`, sorted by `(queued_at, deletion_id)`, and contains at
most 1,024 entries; `key_id` is null or 1..256 printable ASCII bytes. The complete strict-JCS
`LocalStateManifestV1` value is at most 524,288 UTF-8 bytes. If preserving a newly required deletion
would exceed any of these limits, the broker commits no state-changing operation, issues no browser
dispatch, reports `QUARANTINED`, and requires trusted installer cleanup. It never drops, merges, or
evicts an outstanding deletion obligation to fit the bound.

The credential-store manifest is the sole commit pointer for the broker-owned file/key record graph
and supports atomic replacement of one complete strict value. The fixed CLI-readable pairing item
is governed only by the explicit quiescent two-phase transition below; it is not falsely assumed to
share a Keychain transaction with the manifest. The broker holds the installation single-writer lock, re-reads the exact
expected generation immediately before replacement, and uses this
general transaction for every mutation. One transaction may replace zero, one, or several immutable
record slots and then changes exactly one commit pointer—the complete manifest:

1. Read and strictly validate the manifest and every record used as an input; compute the complete
   next pointer set and pending-deletion edits before writing anything.
2. For each changed mutable record, construct a next closed plaintext with generation `old + 1`
   (or immutable grant generation 1) and write a fresh envelope to a same-directory
   `O_CREAT|O_EXCL|O_NOFOLLOW` temporary file of mode `0600`. A transaction that only removes a
   proven-complete deletion intent writes zero new slots; this manifest-only form is explicitly
   valid and does not manufacture an obsolete record.
3. Flush every new file's data/metadata, rename each to its exact immutable slot basename without
   overwriting an existing slot, and flush the parent after the complete batch. Windows uses exclusive creates,
   `FlushFileBuffers`, and a same-volume write-through rename with equivalent no-reparse checks.
4. Reopen every new slot by directory handle, revalidate type/generation/key/digest and cryptographic
   tag, re-read
   manifest generation `g` under the still-held lock, then atomically replace that one credential-
   store item (macOS `SecItemUpdate`) with generation `g + 1`, all changed/unchanged pointers, and
   the complete next deletion-intent set.
   This single-item replacement is the commit point; no unavailable multi-item Keychain transaction
   or compare-and-swap primitive is assumed. A platform build is conforming only after crash-
   injection qualification proves that its one-item replacement is observed after process/OS failure
   as exactly the old value or exactly the new value; otherwise the bridge is disabled there.
5. Re-read the committed manifest. Except while completing the explicit pairing transition, only
   then service an operation, send a dispatch permit/ack, or
   delete superseded slots/keys. Cleanup removes an intent only in a later manifest commit after all
   named keys and files are proven absent.

A crash before step 4 leaves the old state authoritative and every new slot orphaned. A crash after
step 4 leaves the complete new pointer set authoritative and cleanup resumable; a partial pointer
set is never a commit state. There is no fallback to an older
valid slot: that would permit rollback of consent, replay, or rate history. Temporary and orphan
slots are deleted only after the lock is held, the current manifest/index have been validated, and
the exact generated basename is proved unreferenced; orphan per-grant/replay key items under this
installation are queued and deleted by the same rule. After an indeterminate credential-store
update, the broker re-reads the item: exact new bytes mean committed, exact old bytes mean
uncommitted, and any missing/third value is corruption. An indeterminate directory flush is likewise
corruption, never presumed success.

Version 1 has no predecessor and performs no format migration. A future signed migrator must stop
new calls and browser scheduling, take the same lock, authenticate every source record, preserve all
active authority, unexpired replay entries, live tombstones/cleanup intents, unexpired rate
reservations and full deadlines, write and revalidate all destination slots, and replace the
credential-store manifest last. Failure leaves the old manifest authoritative. Unknown newer
versions, downgrade, lossy migration, key substitution, or migration from an unauthenticated source
is refused; no "reset and continue" recovery is conforming.

#### 4.7.3 Authority, binding, tombstone, and cleanup records

```ts
type BrowserTargetBindingV1 = {
  tab_id: number;                       // safe non-negative Chrome tab ID
  document_id: string;                  // exact top-level Chrome documentId, 1..512 UTF-8 bytes
  frame_id: 0;
  exact_origin: "https://app.ynab.com";
  observed_at: string;
};

type ProfileBindingV1 = {
  kind: "dedicated_nab_profile";
  browser_profile_instance: string;
  target: BrowserTargetBindingV1;
  dedicated_profile_absolute_path: string;
  directory_identity: string;           // platform canonical volume/file identity
  expected_parent_directory_identity: string;
  chrome_pid: number;
  chrome_process_start_identity: string;
};

type ConsentBindingRecordV1 = {
  schema: "nab.consent-binding/1";
  installation_id: string;
  generation: 1;
  grant: ConsentGrantV1;
  binding: {
    grant_id: string;
    plan_ref: string;
    ynab_account_fingerprint: string;
    private_budget_fingerprint: string;
    plan_fingerprint: string;
    public_plan_id: string | null;       // null in Version 1 without provider join
    identity_key: string;               // 32 bytes, unpadded base64url
    reference_key: string;              // 32 bytes, unpadded base64url
    profile: ProfileBindingV1;
    browser_cleanup_obligation: ActiveBrowserCleanupObligationV1;
    provider_policy_id: string;
    provider_policy_sha256: string;
  };
};

type AuthorityGrantPointerV1 = {
  grant_id: string;
  plan_ref: string;
  grant_record: LocalRecordPointerV1;   // record_type = grant_binding
};

type GrantCandidateV1 = {
  transaction_id: string;              // UUIDv4
  purpose: "connect" | "renewal";
  phase: "approved_pending_bind";
  replaces_grant_id: string | null;
  candidate: AuthorityGrantPointerV1;
  approved_at: string;
};

type ExpiredGrantTombstoneV1 = {
  grant_id: string;
  plan_ref: string;
  expired_at: string;
  recorded_at: string;
  retain_until: string;                 // recorded_at + exactly 30 days
  pending_cleanup_marker_id: string | null;
};

type BrowserPermissionSetV1 = {
  permissions: ("cookies" | "webRequest")[];
  origins: ("https://app.ynab.com/*")[];
};

type PageObserverCleanupV1 =
  | {
      phase: "registration_scope";
      dynamic_content_script_id: "nab-ynab-page-observer-v1";
      selected_tab_id: number;
      target: null;
      page_instance_id: null;
    }
  | {
      phase: "document_bound";
      dynamic_content_script_id: "nab-ynab-page-observer-v1";
      selected_tab_id: number;
      target: BrowserTargetBindingV1;
      page_instance_id: string;
    };

type BrowserRealmCleanupV1 =
  | {
      phase: "preparation_scope";
      exact_realm_url: string;
      dynamic_content_script_id: "nab-ynab-browser-catalog-v1";
      selected_tab_id: number;
      target: null;
      adapter_instance_id: string;       // UUIDv4 generated before realm mutation
    }
  | {
      phase: "document_bound";
      exact_realm_url: string;
      dynamic_content_script_id: "nab-ynab-browser-catalog-v1";
      selected_tab_id: number;
      target: BrowserTargetBindingV1;
      adapter_instance_id: string;
    };

type ActiveModeCleanupV1 =
  | {
      mode: "page-snapshot";
      page_observer: Extract<PageObserverCleanupV1, { phase: "document_bound" }>;
      browser_realm: null;
    }
  | {
      mode: "browser-catalog";
      page_observer: null;
      browser_realm: Extract<BrowserRealmCleanupV1, { phase: "document_bound" }>;
    }
  | {
      mode: "native-replay";
      page_observer: null;
      browser_realm: null;
    };

type ActiveBrowserCleanupObligationV1 = {
  permissions_if_touched: BrowserPermissionSetV1;
  mode_cleanup: ActiveModeCleanupV1;
};

type BrowserPreparationIntentV1 = {
  preparation_id: string;              // UUIDv4
  provisional_grant_id: string;        // UUIDv4 generated before browser mutation
  provisional_plan_ref: string;        // UUIDv4 generated before profile creation
  replaces_grant_id: string | null;
  mode: "page-snapshot" | "browser-catalog" | "native-replay";
  extension_id: string;
  extension_package_fingerprint: string;
  extension_attestation: ConsentGrantV1["extension_attestation"] | null;
  browser_profile_instance: string | null;
  dedicated_profile: {
    absolute_path: string;
    expected_parent_directory_identity: string;
    directory_identity: string | null;
    chrome_pid: number | null;
    chrome_process_start_identity: string | null;
  };
  profile_phase: "planned" | "directory_created" | "chrome_launched" | "extension_bound";
  permissions_if_touched: BrowserPermissionSetV1;
  page_observer_if_touched: PageObserverCleanupV1 | null;
  browser_realm_if_touched: BrowserRealmCleanupV1 | null;
  browser_mutation: "not_started" | "may_have_occurred";
  created_at: string;
};

type BrowserCleanupMarkerV1 = {
  marker_id: string;                    // UUIDv4
  grant_id: string;
  extension_id: string;
  extension_package_fingerprint: string;
  extension_attestation: ConsentGrantV1["extension_attestation"];
  browser_profile_instance: string;
  permissions_to_remove: BrowserPermissionSetV1;
  page_observer_to_remove: PageObserverCleanupV1 | null;
  browser_realm_to_remove: BrowserRealmCleanupV1 | null;
  credential_capture_to_remove: CaptureListenerCleanupV1 | null;
  capture_permission_request: CapturePermissionRequestLifecycleV1 | null;
  provider_logout_to_attempt: null | {
    provider_policy_id: string;
    provider_policy_sha256: string;
    action: ProviderContractAssetIdentityV1 & { kind: "provider_logout" };
    session_revocation: (ProviderContractAssetIdentityV1 & { kind: "session_revocation" }) | null;
    requested_at: string;
  };
  created_at: string;
  authority_retired_at: string;
  reason:
    | "expired" | "disconnect" | "connect_rollback" | "renewal_teardown_failed"
    | "capture_completion";
};

type CaptureListenerCleanupV1 = {
  capture_id: string;                  // canonical lowercase UUIDv4
  worker_instance_id: string;          // attested service-worker instance UUIDv4
  listener_epoch: string;              // 32 random bytes, unpadded base64url
  web_request_listener_roles: [
    "selected_before_request",
    "all_tabs_catalog_sentinel",
    "selected_before_send_headers",
    "selected_before_redirect",
    "selected_completed",
    "selected_error"
  ];
  cookie_listener_role: "selected_store_cookie_changed";
  permission_listener_roles: ["permission_added", "permission_removed"];
};

type CapturePermissionRequestLifecycleV1 =
  | {
      request_epoch: string;            // 32 random bytes, unpadded base64url
      state: "not_started";
      settlement: null;
    }
  | {
      request_epoch: string;
      state: "may_be_in_flight";        // durable conservative state before arming the UI
      settlement: null;
    }
  | {
      request_epoch: string;
      state: "settled";
      settlement:
        | {
            outcome: "not_started_cancelled";
            request_started_before_deadline: false;
            permission_event_generation: number;
          }
        | {
            outcome: "resolved_true" | "resolved_false" | "rejected";
            request_started_before_deadline: true;
            permission_event_generation: number;
          };
    };

type CaptureCleanupIntentV1 = {
  schema: "nab.capture-cleanup-intent/1";
  capture_id: string;                  // canonical lowercase UUIDv4
  grant_id: string;
  plan_ref: string;
  extension_id: string;
  extension_package_fingerprint: string;
  extension_attestation: ConsentGrantV1["extension_attestation"];
  browser_profile_instance: string;
  permissions_to_remove: {
    permissions: ["cookies", "webRequest"];
    origins: ["https://app.ynab.com/*"];
  };
  credential_capture_to_remove: CaptureListenerCleanupV1;
  permission_request: CapturePermissionRequestLifecycleV1;
  phase: "armed_before_permission";
  created_at: string;
  permission_gesture_before: string;    // min(created_at + 5 minutes, authorization expiry)
};

type RetiredProfileOwnershipV1 = {
  grant_id: string;
  plan_ref: string;
  browser_profile_instance: string;
  dedicated_profile_absolute_path: string;
  directory_identity: string;
  expected_parent_directory_identity: string;
  chrome_pid: number;
  chrome_process_start_identity: string;
  cleanup_job:
    | { state: "none"; job_id: null; envelope_sha256: null }
    | { state: "prepared" | "registered"; job_id: string; envelope_sha256: string };
  recorded_at: string;
  reason: "grant_expired" | "disconnect_cleanup_pending" | "connect_rollback_cleanup_pending" |
    "renewal_teardown_cleanup_pending" | "capture_cleanup_pending";
  cleanup: "manual_confirmation_required";
};

type AuthorityIndexV1 = {
  schema: "nab.authority-index/1";
  installation_id: string;
  generation: number;
  active: AuthorityGrantPointerV1 | null;
  candidate: GrantCandidateV1 | null;
  browser_preparation: BrowserPreparationIntentV1 | null;
  expired_tombstone: ExpiredGrantTombstoneV1 | null;
  browser_cleanup_marker: BrowserCleanupMarkerV1 | null;
  capture_cleanup_intent: CaptureCleanupIntentV1 | null;
  retired_profile: RetiredProfileOwnershipV1 | null;
};
```

The grant, binding, pointer, profile instance, mode, and three fingerprints must agree exactly; the
policy hash is lowercase SHA-256 and must match the revalidated signed release asset. The dedicated
path is absolute, normalized without `.`/`..`, and accepted only if it is below the pre-recorded
NAB-owned profile parent and its saved directory identity still matches. Existing-profile records
do not exist in Version 1. `target` is an exact consent-time channel binding, not a reusable tab locator:
Chrome tab IDs are browser-session-local and `document_id` changes on navigation. A tab close,
top-level navigation/reload, document-ID change, frame mismatch, browser restart, or Native port loss
makes the binding unusable and requires foreground renewal with a newly selected target; the broker
never scans for a replacement or updates the immutable grant in place. The sole port-close
exception is the native-replay capture handoff below: the existing target/document remains open and
is revalidated, the data port is first definitively drained, the capture port is freshly attested,
and `capture_cleanup_intent` is durably committed before the broker deliberately closes that exact
drained data port. An unexpected loss before that commit still invalidates the binding; any failure
after it follows forward capture retirement and never resumes data authority. Raw private user/budget/
version/entity IDs and display labels are forbidden.

The immutable grant cleanup obligation is copied exactly from the document-bound preparation and
contains both the possible permission set and mode cleanup. The possible set is fixed before any
browser mutation: page-snapshot and browser-catalog use
`{permissions:[],origins:["https://app.ynab.com/*"]}`; native-replay uses
`{permissions:["cookies","webRequest"],origins:["https://app.ynab.com/*"]}`. It is safe for the set
to name a permission never granted because removal is idempotent and postconditions require absence.
The closed mode matrix is the same as the marker matrix below. Expiry copies the complete set and
mode cleanup into the marker before retiring authority. Disconnect copies the complete set when
permission removal was requested and otherwise the closed empty set, while always copying mode
cleanup. Rollback copies the preparation's possible set and cleanup fields. Neither path
reconstructs an adapter instance, tab, document, or permission list after a crash.

`AuthorityIndexV1` contains zero or one active grant, candidate, browser-preparation intent, expired
tombstone, browser-cleanup marker, capture-cleanup intent, and retired-profile record. A renewal candidate must name the active grant; a connect
candidate requires `active = null`. Before accepting new consent, the broker removes an expired
tombstone whose `retain_until` has passed only when its cleanup marker has also been acknowledged.
An unresolved tombstone, marker, capture intent, or retired-profile record blocks a different new consent rather
than being overwritten. Re-consent may consume the matching tombstone/marker/retired-profile tuple
only when the trusted dialog names the same `plan_ref`, profile instance, and saved directory
identity and executes the closed cleanup/rebind transition. It never consumes a live capture intent;
that intent first follows its mandatory forward-retirement transition. A tombstone is otherwise removed at its
deadline, by an explicitly confirmed disconnect/re-consent that names its `plan_ref`, or uninstall.
A cleanup marker persists until the matching pinned extension completes every named observer,
realm, and capture-listener teardown, removes every named permission/origin, proves all
postconditions, and returns an
authenticated ack; or until the one-shot helper plus broker independently prove the exact dedicated
profile directory absent, which necessarily removes that profile's extension registrations and
optional permissions. Uninstall may instead report that cleanup could not be completed. A profile-
deletion proof never counts as provider logout/session revocation. The marker contains
no filesystem path, provider ID, or secret. `permissions` and `origins` are each duplicate-free and
raw-UTF-8 sorted. `origins` is either empty or exactly `["https://app.ynab.com/*"]`; the permissions
array is a subset of the two literals in `BrowserPermissionSetV1`. A page-snapshot marker has a
non-null observer cleanup record and null realm/capture records; a browser-catalog marker has a
non-null realm record and null observer/capture records. A native-replay marker other than
`capture_completion` has all three mode-cleanup records null and a null capture-permission lifecycle.
A `capture_completion` marker has only the non-null capture-listener record and non-null
capture-permission lifecycle copied exactly from its intent. The realm URL equals the exact signed
mode-contract URL, contains no credentials/query/fragment, and the adapter instance ID is a
canonical lowercase UUIDv4. The three mode-cleanup records are one-hot-or-none: a marker can never
name more than one of page observer, browser realm, or capture listener; the capture-permission
lifecycle is non-null if and only if the capture-listener record is non-null.
`provider_logout_to_attempt` is non-null only for an explicitly requested disconnect and only when
the policy's executable logout asset exists; expiry, rollback, renewal teardown, and capture
completion set it null. Cleanup re-resolves the
exact signed policy by ID/hash and both assets by ID/kind/schema/hash. If the release omits any exact
bytes or accepted current time is outside the policy interval, no provider request occurs and the
logout result is the fixed permission failure. The referenced logout
asset must specify an exact same-origin action, credential/CSRF acquisition without export, closed
request bytes and headers, manual-redirect handling, timeout, idempotent replay after crash, a
response-success predicate, and whether/how the separate revocation proof is obtained. Without that
complete executable asset, the request reports `provider_logout = failed`, stores no guessed action,
and continues local/browser teardown.
The encrypted retired-profile record persists after expiry because the safe cleanup path cannot be
reconstructed from a nonsecret tombstone. It is removed only after a confirmed deletion job completes,
an explicit trusted choice to retain/unmanage that profile, matching re-consent, or uninstall.

Initial `browser_preparation` is committed in `planned` phase before its directory exists;
extension attestation/profile instance/observer/realm are null. The broker advances only
`planned -> directory_created -> chrome_launched -> extension_bound`, filling the exact identity
fields named by each phase and never clearing a later field. `directory_created` requires directory
identity and null process fields; `chrome_launched` additionally requires PID/start identity;
`extension_bound` additionally requires non-null profile instance/attestation and, for page mode, a
registration-scope observer cleanup target or, for browser-catalog, a preparation-scope realm
cleanup target. Before any permission request, dynamic-script
registration, reload, or realm creation, `browser_mutation` is still `not_started`; immediately
before `preparation_armed` it commits `may_have_occurred`. After controlled reload/realm creation it
may replace only the applicable cleanup target with its exact document-bound form. Candidate creation requires the same provisional grant/profile/mode and
leaves the preparation intent present. Successful activation atomically consumes both candidate and
preparation into the active grant without running cleanup. Rollback or startup with a
fully `extension_bound`/`may_have_occurred` intent atomically clears the candidate, creates the
field-for-field `connect_rollback` marker and (when ownership fields are complete) matching retired
profile record, and retires a replaced grant before deleting candidate keys. Earlier-phase or
`not_started` startup does not blindly clear an existing profile: absent planned path clears the
intent, otherwise the trusted cleanup UI retains the intent, closes only the exact saved process
when available, and may convert complete ownership to a retired-profile record after explicit
confirmation. An identity-null path is never recursively deleted or inferred. Thus a crash cannot
leave a granted permission, observer, catalog realm/adapter closure, process, or created profile
without a durable obligation.

Cross-record combinations are closed. An expired tombstone has non-null
`pending_cleanup_marker_id` if and only if an `expired` cleanup marker exists; IDs and grant IDs must
agree. An `expired` marker exists if and only if its matching tombstone exists. A `disconnect`,
`connect_rollback`, `renewal_teardown_failed`, or `capture_completion` marker requires no tombstone.
A rollback marker requires `active = null` and
`candidate = null`, names the provisional grant ID, and blocks new consent until cleanup. A renewal
rollback after `may_have_occurred` also retires the already-drained old grant and queues its key/file;
a reload/permission/observer/realm ambiguity is never hidden behind apparently live old authority. A
preparation may coexist with an old active grant only for renewal and its
`replaces_grant_id` must equal that grant; otherwise preparation requires active null. Preparation
and cleanup marker are mutually exclusive. A `capture_completion` marker requires `active`,
`candidate`, `browser_preparation`, and `capture_cleanup_intent` all null; has the exact
native-replay permission tuple; has null page-observer/browser-realm cleanup and the exact non-null
capture-listener cleanup plus permission-request lifecycle copied from the consumed intent; has
provider logout null; and has one
matching `retired_profile` with reason `capture_cleanup_pending`. A
`grant_expired` retired profile must match the tombstone's grant/plan/profile;
`disconnect_cleanup_pending` and `connect_rollback_cleanup_pending` require no tombstone and name
the retired disconnect/provisional grant respectively. `renewal_teardown_failed` and
`renewal_teardown_cleanup_pending` occur as a pair, name the old active grant, and require
active/candidate/preparation null. `capture_completion` and `capture_cleanup_pending` also occur as
a pair, name the consumed capture grant/plan/profile, and require the exact listener epoch/capture ID
from the consumed intent. The same authority transaction copies the old active cleanup and
profile ownership, queues its grant key/file, and blocks consent until cleanup. Every retired profile has complete parent,
directory, and Chrome process-start identity; incomplete preparation ownership remains in
`browser_preparation` instead. A newly retired profile starts with `cleanup_job.state="none"`.
`prepared`/`registered` require a canonical job UUID and lowercase envelope digest and can exist only
with that same retired profile; `none` requires both nullable members null.
Any retired slot requires `active = null`; `candidate` is also null except during exact same-context
re-consent, when its `plan_ref`/profile/directory identity must match and activation consumes the
retired slots atomically. Before any re-consent activation, retain/unmanage choice, or other
transition clears/reuses a retired profile, `cleanup_job` must be returned to `none`: unregister the
exact registered job, prove the label absent, prove no helper process for its job identity remains,
delete the exact authenticated envelope only after it is unregistered, and commit the null link.
An active grant and a prepared/registered profile cleanup job are mutually exclusive; a profile is
never relaunched/reused while an old helper could delete it. Every other combination is authenticated corruption, not a recoverable
partial state.

While that exact `capture_completion` marker exists, the only host-cardinality exception is the
section 8.1 terminal handoff: for no more than five seconds, one terminal-only old capture host and
one unacknowledged matching cleanup hello may coexist. Active/candidate authority, outstanding
challenge, staged seed, scheduler, and data host are all absent. The cleanup connection has no
authority until the broker proves the capture host absent and promotes it; failure merely retains
the marker.

`capture_cleanup_intent` is the sole narrow exception that may coexist with active grant authority:
it requires exactly one active `native-replay` grant with matching grant/plan/extension/profile/
attestation fields, no candidate, preparation, marker, retired profile, or scheduler run. During the
at-most-five-second precommitted handoff it may also coexist with the one already-drained old data
host solely until the broker deliberately closes and proves that port absent; no data/control frame
is accepted from it. In the resulting steady capture state there is no data host,
and—while the owning process is live—exactly one credential-capture host for its `capture_id`.
Startup may observe the authenticated intent with zero live hosts after a crash, but that is a
recovery input only: it performs the forward transition below before publishing either socket. The
broker commits the intent under the installation lock before requesting any optional permission or
installing any capture listener. While it exists, `bridge.ping` remains available and authenticated
`session.status` returns `capture_in_progress`; `pending.list`, `pending.get`, and
`session.disconnect` fail with `CAPTURE_IN_PROGRESS`, and a second capture gesture is refused. It is
never cleared back to an ordinary active grant. Terminal completion, consent expiry, policy expiry/
revocation, clock quarantine, host/worker/browser loss, process crash, or startup first erases any
staged secret and then atomically clears `active` and the grant schedule; consumes the intent
into a `capture_completion` marker by copying every common extension/profile/permission/listener/
permission-request-lifecycle
field exactly and generating only a new `marker_id`, `created_at`, and `authority_retired_at`;
creates `retired_profile` from the still-authenticated active `ProfileBindingV1` with reason
`capture_cleanup_pending`; queues all grant/binding/cache/native-credential deletion intents; and
leaves pairing intact. Startup performs that forward transition before accepting sockets. Thus
optional-permission/listener ambiguity and the still-authenticated dedicated profile always have a
durable cleanup authority even though the capture seed itself has no durable representation.
The initial intent has `permission_request.state="not_started"`. Immediately before emitting
`capture_permission_armed`, the broker atomically changes it to the conservative
`may_be_in_flight` state; that transition is deliberately earlier than the eventual click because
no Native message can be made atomic with Chrome's synchronous user-gesture call. The bound popup
document alone keeps the precise gesture state `not_started -> in_flight -> settled`; it cannot
relay `in_flight` without sacrificing the synchronous gesture. The service worker owns only
`permission_observers_armed -> awaiting_popup_result -> settled`, installs
`chrome.permissions.onAdded` and `onRemoved` observers before enabling the final button, and reports
a settled lifecycle only after it receives the one epoch-bound popup settlement (or a separately
acknowledged never-started cancellation) and its specified task/event barrier drains queued
permission events. The
broker commits that exact settled projection before it sends a permission receipt or challenge.
Malformed/lost results leave the durable state `may_be_in_flight`; they never infer settlement from
a timer, port close, worker death, or browser restart. `permission_gesture_before` is only the last
instant at which the synchronous request may begin. It is not a deadline after which an already
open Chrome prompt is presumed cancelled.

Capture retirement copies the lifecycle exactly into the marker. A marker containing
`not_started` is removable by the broker's proof that the armed message was never emitted. A marker
containing `settled` requires the matching drained settlement proof. A marker containing
`may_be_in_flight` can transition to the same proof only if the original attested worker later
reports that exact request epoch settled and drains the permission-event queue; otherwise neither
`permissions.remove`, `permissions.contains(false)`, ordinary worker destruction, nor elapsed time
may clear it. The only alternative is the existing broker-authenticated whole-profile path: stop
and prove absent the exact saved Chrome process and independently prove the exact dedicated profile
directory absent. That destructive profile proof necessarily eliminates both a still-open prompt
and any later persisted grant. Until one of those two proofs completes, status continues to report
pending browser cleanup and all capture/re-consent is blocked.
This capture-retirement transition has precedence over the ordinary expiry transition whenever the
intent exists; it creates no incompatible `expired_tombstone`. The terminal UI still reports the
exact consent/policy/quarantine cause, but the durable marker reason remains `capture_completion` so
listener and profile cleanup cannot be lost.

Renewal first drains the old port/scheduler. For page-snapshot or browser-catalog it then performs
the old active obligation's hard document teardown and proves the old target absent before creating
the preparation-scope obligation for a fresh document and adapter/observer instance. An ambiguous
old teardown retires the old authority and creates its cleanup marker; it cannot preserve the old
grant or activate the candidate. Successful activation transfers only the new document-bound
obligation. Native-replay has no standing MAIN adapter after its one-shot capture, so its mode
cleanup is the closed null/null variant.

Candidate creation first creates its grant key and immutable encrypted grant record, then commits an
index that references it. Only the explicit candidate-bind flow may decrypt that non-active record.
Activation commits one index that moves the candidate to `active`, clears `candidate`, and, for
renewal, queues the replaced grant key/file for deletion, and clears the matching preparation in the
same manifest compare-and-swap.
Cancel, timeout, failed bind, or restart with a candidate atomically clears it and queues its key/file
before any extension bind or private access. No candidate is resumed after restart.

Expiry and disconnect first commit an authority index with `active = null` and the appropriate
tombstone/cleanup marker and, for an expiring dedicated profile, `retired_profile` (disconnect uses
no expired tombstone), while the same manifest update
queues the grant key/file. From that commit onward the grant is unusable. The broker then deletes the
per-grant OS key before deleting ciphertext and completes the deletion intent. Failure to delete the
key keeps cleanup pending, makes `local_authority_revoked = false` for disconnect, and prevents new
consent; it never restores the retired pointer. This per-grant key deletion is the Version 1
cryptographic-erasure boundary; filesystem block erasure is not claimed.

#### 4.7.4 Replay record

```ts
type ReplayEntryV1 = {
  nonce: string;                        // 32 bytes, unpadded base64url
  expires_at: string;                   // exact request expiry; no post-expiry grace
};

type ReplayStateV1 = {
  schema: "nab.replay-state/1";
  installation_id: string;
  pairing_epoch: string;                // UUIDv4, exact pairing-key epoch
  generation: number;
  entries: ReplayEntryV1[];
};
```

Entries are unique and sorted by raw nonce bytes. `expires_at` is the request's exact expiry under
section 7.2. Under the installation lock, the broker removes only entries whose deadline is less
than or equal to its accepted current time, rejects a duplicate,
adds the new entry, and commits the new replay pointer before semantic validation or any browser
message. If more than 32,768 unexpired entries would remain, it returns no authenticated operation
result and performs no dispatch until the earliest entry expires or the user re-pairs; it never
evicts an unexpired nonce. At the fixed 43-byte base64url nonce and fixed millisecond UTC timestamp
grammar, 32,768 entries plus the complete closed record remain below the 8 MiB plaintext ceiling;
both the entry-count and byte ceilings are checked before commit. A semantic failure leaves the
committed entry in place.

Pairing/re-pairing first unlinks the CLI listener, drains all accepted connections, and holds the
installation lock. It constructs and size-checks both possible final manifests, creates a fresh
credential/epoch/replay key and empty authenticated replay slot, and commits
`PairingTransitionV1` while leaving the old active/replay pointers unchanged. It then performs one
conditional Add (expected absent) or Update (expected exact old digest) of the fixed pairing item and
re-reads that direct query. Exact `next` commits a final manifest that promotes the next identity/
replay pointer, advances `last_pairing_generation`, clears the transition, and queues the old replay
key/file. Exact `expected_item_before` rolls back the manifest and queues the new replay key/file.
Missing/third/duplicate results quarantine; a transiently unavailable query leaves the transition
and all sockets unpublished. A live-grant re-pair may authorize only a CLI fingerprint equal to the
grant and policy; changing it requires disconnect/re-consent.

Startup resolves a transition before deletion or socket publication. Fixed item equal to `next`
rolls forward; equality to `expected_item_before` (including absence for initial pair) rolls back;
anything else quarantines. A `trusted_recovery` transition is the sole signed-installer/user-presence
path that may tolerate a missing old replay envelope or use null expected-item while old pairing
metadata exists; it still creates a fresh generation/epoch and never accepts a third credential.
This explicit exception is safe only while listeners are unlinked and supersedes the generic input-
authentication rule for that one replay record.

The CLI directly reads the single fixed service/account item immediately before each one-request
socket connection, verifies its closed JCS/install/fingerprint grammar, and retains the key only
through authenticated EOF. After any local authentication failure or EOF it re-reads once before a
new connection; a pre-rotation read never selects a stale epoch indefinitely. The broker accepts
requests only in paired steady state and requires the item's digest/generation/epoch and replay
pointer to equal the manifest. Thus delayed deletion of old replay material cannot create a second
CLI-selectable key.

A replay pointer/key/epoch mismatch requires re-pairing. If the manifest is valid but
the referenced replay envelope is missing or unauthenticated, the broker refuses all authenticated
operations for 35 monotonic seconds measured from detection (which is startup when detected during
startup); every restart redetects the condition and restarts that interval. After the interval, all Version 1 requests that could have been accepted by
the lost window are expired, so the broker may commit a new empty record under the same epoch. It may
instead require re-pairing. It never reconstructs an empty window sooner or while wall/monotonic time
cannot be trusted.

#### 4.7.5 Installation-wide scheduler/rate record

```ts
type RateReservationV1 = {
  burst_reservation_id: string;         // UUIDv4
  reserved_slots: number;               // exact signed burst maximum
  reserved_at_utc: string;
  boot_id: string;
  reserved_at_monotonic_ms: number;
};

type PersistedDeadlineV1 = {
  not_before_utc: string;
  recorded_at_utc: string;
  recorded_boot_id: string;
  recorded_monotonic_ms: number;
  delay_ms_at_record: number;
};

type ActiveSchedulerRunV1 = {
  run_id: string;                      // UUIDv4
  burst_reservation_id: string;
  kind: "initialize" | "refresh";
  run_not_after: PersistedDeadlineV1;  // exactly 120,000 ms from reservation
};

type GrantScheduleV1 = {
  grant_id: string;
  next_due: PersistedDeadlineV1 | null;
  last_burst: RateReservationV1 | null;
  active_run: ActiveSchedulerRunV1 | null;
  predispatch_retry_used: boolean;
  result_class:
    | "never_run" | "success" | "provider_delay" | "predispatch_failure"
    | "terminal_failure" | "ambiguous";
  terminal_state:
    | "reauth_required" | "permission_denied" | "protocol_update"
    | "session_state_unknown" | "read_result_unknown" | "ambiguous_commit"
    | "security_challenge" | "provider_unavailable" | "provider_error"
    | "quarantined" | null;
};

type RateQuarantineV1 = {
  reason: "clock_uncertain";
  detected_at_utc: string;
  detected_boot_id: string;
  detected_monotonic_ms: number;
  no_dispatch_before_monotonic_ms: number; // detection monotonic + exactly 3,600,000 on this boot
  no_dispatch_before_utc: string;       // detection + exactly 3,600 seconds
};

type RateStateV1 = {
  schema: "nab.rate-state/1";
  installation_id: string;
  generation: number;
  last_observed_utc: string;
  boot_id: string;
  reservations: RateReservationV1[];
  latest_burst_started: RateReservationV1 | null; // retained independently of rolling slots
  cadence_not_before: PersistedDeadlineV1 | null; // installation-wide, survives grant retirement
  provider_not_before: PersistedDeadlineV1 | null;
  schedule: GrantScheduleV1 | null;     // null when no active grant
  quarantine: RateQuarantineV1 | null;
};
```

Authenticated rate-state cross-field invariants are part of decoding, not scheduler advice:

| State | Required invariant |
| --- | --- |
| installer initial | generation 1; empty reservations; all burst/deadline/schedule/quarantine fields null; `boot_id` is the sampled current boot and `last_observed_utc` is the same bootstrap sample |
| authority cardinality | `schedule` is non-null iff `AuthorityIndexV1.active` is non-null; their grant IDs agree. Candidate/preparation does not create a second schedule; retirement clears schedule in the same manifest transaction |
| idle runnable schedule | `active_run = null`, `terminal_state = null`; `next_due` is null only for a never-dispatched newly activated grant eligible immediately, otherwise it is the exact max-deadline construction below |
| active run | terminal and `next_due` are null; `last_burst`, `latest_burst_started`, and the reservation named by `active_run.burst_reservation_id` are byte-for-byte the same reservation, present exactly once; `reserved_slots` equals the signed whole-burst maximum; `run_not_after` is derived from that reservation by exactly 120,000 ms on both clocks |
| terminal schedule | `active_run = null`, `next_due = null`; reauth/permission/protocol/security/provider failures require `result_class="terminal_failure"`; session/read/commit ambiguity requires `result_class="ambiguous"`; `terminal_state="quarantined"` requires `result_class="terminal_failure"` |
| nonterminal result | `result_class` is `never_run`, `success`, `provider_delay`, or `predispatch_failure`; `success` requires non-null `last_burst` and `predispatch_retry_used=false`; `provider_delay` requires non-null `provider_not_before`; `never_run` requires null `last_burst` unless inherited through an explicitly defined recovery transition |
| cleanup/no authority | schedule null; installation-wide reservations, latest burst, cadence/provider deadlines, clock quarantine, and observed clock fields remain exactly as previously committed |

Every non-null deadline has a safe non-negative delay and exact UTC addition. For a deadline armed
on the current boot, `recorded_boot_id == RateStateV1.boot_id`; after a boot transition every still-
relevant deadline is replaced by the required full-delay re-arm before scheduling. `schedule.last_burst`
is either null or equals a historically committed reservation; an `active_run` additionally requires
that reservation still be in `reservations`. `latest_burst_started` may outlive its rolling-window
reservation but can only equal the most recently committed burst by `(reserved_at_utc,
reserved_at_monotonic_ms, burst_reservation_id)`. The quarantine detection boot equals state boot,
its UTC and monotonic no-dispatch deadlines are exactly detection plus 3,600 seconds/3,600,000 ms,
and it may coexist only with a non-active schedule whose next eligibility takes the maximum of the
quarantine and other deadlines. A contradictory MAC-valid combination is local corruption.

The broker obtains `boot_id` and a monotonic millisecond clock from an OS facility whose values
cannot be supplied by a caller; a platform without both cannot enable a private scheduler.
Reservations are unique and ordered by `(reserved_at_utc, burst_reservation_id)`. Their slot-count
sum, not array length, is the rolling-hour usage. On the same boot, monotonic age is authoritative.
Wall time is never used to prove that a rate, cadence, or provider delay elapsed across a boot.
For every `PersistedDeadlineV1`, `not_before_utc` must equal
`recorded_at_utc + delay_ms_at_record`, and on the same boot its
monotonic deadline is `recorded_monotonic_ms + delay_ms_at_record`; both applicable clocks must reach
the deadline. On every boot-ID change—or whenever wall/monotonic trust is uncertain—the broker first
commits a fresh full 3,600-second quarantine on the new boot's monotonic clock. It also re-arms every
still-relevant provider/cadence deadline for its complete original `delay_ms_at_record` from the new
clock pair, not a wall-clock-derived remainder. A boot change during quarantine repeats that rule.

Before `scheduler_run`, the broker commits one reservation with the exact signed whole-burst slot
count, replaces `latest_burst_started`, sets installation-wide `cadence_not_before` to that start
plus the full signed refresh interval, and commits an `active_run` with a 120,000 ms deadline.
No permit may outlive that run deadline. At it, the broker sends no further permit, treats any
possibly dispatched unfinished request as ambiguous, destroys the logical device, and closes the
run. Before `dispatch_outcome_ack`, it commits any valid provider deadline and result transition.
Before exposing a final run result, it commits `next_due`, retry flag, terminal state, and clears
`active_run`. Expiry/disconnect retirement clears only `schedule`; it never clears reservations,
`latest_burst_started`, `cadence_not_before`, `provider_not_before`, `last_observed_utc`, or
quarantine. The rate key, installation ID, record, and live history survive
grant expiry, disconnect, pairing deletion, profile deletion, and re-pairing; only explicit product
uninstall removes them.

Renewal is not a cadence reset: in the same activation transaction that changes authority, the
broker drains/clears any old `active_run`, changes `schedule.grant_id` to the candidate grant, and
copies the old `next_due`, `last_burst`, and `predispatch_retry_used`. It preserves
`provider_not_before`, `cadence_not_before`, and clock quarantine as installation-wide fields.
`maxDeadline(...)` is the latest same-boot monotonic deadline among every non-null argument; after a
boot change every surviving argument is first re-armed in full and the latest new monotonic deadline
wins. Every runnable activation—renewal or a fresh grant after no active grant—sets `next_due` to
`maxDeadline(old_next_due_if_any, cadence_not_before, provider_not_before,
quarantine.no_dispatch_before_if_any)`. No new consent, pairing, profile, policy selection, or grant
can remove or shorten an installation-wide deadline. When a newly signed policy has a longer
interval, the broker extends `cadence_not_before` from `latest_burst_started`; after a boot change it
conservatively waits the complete new interval from the new clock because prior elapsed time cannot
be proved. Thus disconnect/re-consent cannot bypass a provider delay, cadence, or quarantine even
after rolling-hour slots age out. Startup finding non-null `active_run`
means a request may have dispatched: it commits the corresponding ambiguity terminal state, keeps
the reservation, destroys browser state, and never resumes that run.

Terminal inheritance/recovery is closed:

| Old `terminal_state` | Renewal transition |
| --- | --- |
| null | remains null |
| `reauth_required` | clears only after ordinary login and the new exact identity/build probe succeeds under `recovery_contracts.reauthentication`; otherwise inherited |
| `security_challenge` | same, with proof that the provider challenge is gone; NAB never solves it |
| `permission_denied` | clears only with non-null `permission_restore`, new explicit consent, and a successful selected-relation permission/identity probe; otherwise inherited |
| `protocol_update` | clears only in a newly signed binary whose required policy/mode/schema/adapter hashes changed and whose compatibility+identity probes succeed; same-release renewal inherits it |
| `provider_unavailable` or `provider_error` | clears only through non-null `provider_failure` plus a successful provider/identity probe; otherwise inherited |
| `session_state_unknown` | clears only through non-null `ambiguous_session`, explicit acknowledgement, destruction of the old realm/device, ordinary reauthentication/recapture, and fresh-device bootstrap proof |
| `read_result_unknown` | clears only through non-null `ambiguous_read`, explicit acknowledgement, old-device destruction, and fresh-device bootstrap proof |
| `ambiguous_commit` | clears only through non-null `ambiguous_commit`, provider/human reconciliation, explicit acknowledgement, and fresh-device proof; an agent cannot authorize it |
| `quarantined` | never clears through renewal; explicit disconnect/uninstall or a future authenticated migration contract is required |

A referenced recovery-contract ID must resolve to canonical provider-reviewed bytes whose SHA-256 is
bound by the signed release; a nonempty opaque label alone is insufficient. Clearing sets
`terminal_state = null`, `result_class = "never_run"`, and a cadence/rate-bounded initialization due;
inheriting keeps the old result class and `next_due = null`. `predispatch_retry_used` is never reset
by renewal or recovery; only a complete later scheduled success clears it. Repeated foreground
renewal therefore cannot manufacture retry allowance, erase ambiguity, or shorten a deadline.

Every same-boot ordinary update removes a reservation only when its authoritative age is at least
3,720 seconds: the 3,600-second rolling window plus the fixed 120-second maximum delay from burst
reservation to physical dispatch. On a new boot, old-boot reservations remain counted throughout
the fresh 3,600-second quarantine and may be removed only after it completes. This ensures a slow
request cannot physically dispatch after its pre-counted slot aged out. A provider deadline is
cleared only after its full deadline. A missing, malformed, digest-mismatched, or MAC-invalid rate
file/key/manifest is fatal local corruption and cannot be replaced after a finite wait: the lost
record could contain a seven-day provider deadline or 24-hour cadence. Version 1 has no authenticated
backup and cannot recover it; only explicit uninstall can remove the unusable installation, and no
private dispatch occurs before that removal/new consent.
Any migration must preserve every reservation not eligible
for removal under the preceding 3,720-second/cross-boot rule, `latest_burst_started`, the greater of
every provider/quarantine/cadence deadline, and all terminal state.
The replay-after-35-seconds replacement is the only exception to transaction step 1's requirement
to authenticate the replaced payload: the credential-store manifest and
pointer must still be valid, the new generation is exactly pointer generation plus one, the bad slot
is queued without importing any field from it, and the complete conservative delay is committed
before the replacement pointer. Authority/index/rate corruption has no such reset path.

#### 4.7.6 Startup reconciliation and deletion

Before publishing either broker socket, startup holds the lock and, in order: directly reads and
validates the immutable installation metadata; validates the credential-store manifest and its
metadata digest; resolves any pairing transition/retirement against the one direct fixed-
item query; validates its installation ID and all current pointers (with only the explicit replay
conservative-replacement exception in section 4.7.4); performs the forward-only
`capture_cleanup_intent` transition, if present, in the same authority+rate transaction that clears
its active pointer and schedule; converts/clears any browser preparation under its exact crash rule;
rolls back any candidate; drains every pending key/file deletion; compacts the expired tombstone and
replay entries; revalidates the rate record/clock rule; and only then loads the active grant. It also
runs the bounded profile-cleanup envelope/OS-registration reconciliation below
before publishing sockets. Retirement is forward-only: exact old fixed item resumes its digest-bound deletion;
confirmed absence detaches/queues the old replay state and clears retirement; a third/duplicate item
quarantines and is never deleted. It does not contact Chrome or YNAB during record reconciliation;
browser cleanup begins only afterward through its closed marker.

Corrupt manifest/authority/grant state publishes neither CLI nor host socket, so it cannot truthfully
emit a normal `SessionStatusResultV1` or accept `session.disconnect`/re-consent using untrusted
identity fields. The signed local launcher reports a fixed `LOCAL_STATE_CORRUPT` pre-protocol error
and offers only diagnostic details plus explicit uninstall using installer-owned paths/IDs. There is
no Version 1 backup/restore path. It never fabricates a live `quarantined` status, discovers another profile/budget,
or resets state to regain service.

The only durable file outside the manifest graph is a requested one-shot dedicated-profile deletion
job. It has its own closed envelope and a two-phase link from `retired_profile`; OS registration is
the external scheduling commit and the protected link makes crash reconciliation discoverable:

```ts
type ProfileCleanupJobEnvelopeV1 = {
  schema: "nab.profile-cleanup-envelope/1";
  installation_id: string;
  job_id: string;
  helper_key_id: string;
  wrapped_job_key: string;              // libsodium crypto_box_seal output, unpadded base64url
  created_at: string;
  nonce: string;                        // 24 random bytes, unpadded base64url
  ciphertext: string;                   // ciphertext || tag, unpadded base64url
  broker_auth_tag: string;              // 32-byte HMAC, unpadded base64url
};

type ProfileCleanupJobV1 = {
  schema: "nab.profile-cleanup-job/1";
  installation_id: string;
  generation: 1;
  job_id: string;                       // UUIDv4; agrees with key and basename
  grant_id: string;
  plan_ref: string;
  browser_profile_instance: string;
  dedicated_profile_absolute_path: string;
  expected_directory_identity: string;
  expected_parent_directory_identity: string;
  cleanup_quarantine_basename: string;  // "pending-delete-" + lowercase job UUID
  chrome_pid: number;                   // safe positive integer
  chrome_process_start_identity: string;
  registration_descriptor_sha256: string;
  created_at: string;
  execute_not_before: string;
  expires_at: string;                   // <= created_at + 24 hours
};
```

The job filename is exactly `profile-cleanup.<lowercase-job-uuid>.aead`. The OS job label is exactly
`io.nab.ynab-bridge.profile-cleanup.<lowercase-job-uuid>`. The broker generates a
fresh 32-byte per-job key, wraps it to the installer-pinned X25519 cleanup-helper public key using
libsodium `crypto_box_seal` (X25519/XSalsa20-Poly1305), then immediately destroys its plaintext key
after the durable job envelope and registration have been verified. `wrapped_job_key` is exactly the
80-byte sealed-box output for a 32-byte plaintext. Sealed-box encryption authenticates no sender, so
it is confidentiality/key handoff only. Job encryption is XChaCha20-Poly1305-IETF under that per-job
key. Its AAD is `UTF8("nab-profile-cleanup-envelope-v1\0") || UTF8(JCS(header))`, where `header` is
the complete envelope with both `ciphertext` and `broker_auth_tag` omitted. After inserting the
ciphertext, the broker computes
`HMAC-SHA-256(profile_cleanup_broker_auth_key,
UTF8("nab-profile-cleanup-origin-v1\0") || UTF8(JCS(envelope without broker_auth_tag)))`.
The helper verifies that tag in constant time through its identity-restricted key access before
unwrapping the job key or opening any target. Plaintext is JCS of `ProfileCleanupJobV1`.

Before allocation, broker/startup/helper `fstat` the nonsymlink regular file and require size
`1..65,536` bytes. The envelope parser uses fixed depth 4, at most 16 object members, no arrays,
8,192-byte ordinary-string ceiling, exact 107-character `wrapped_job_key`, exact 32-character nonce,
exact 43-character broker tag, and at most 43,712 base64url characters of ciphertext; it rejects
padding and checks encoded lengths before decoding. Decoded plaintext JCS is at most 32,768 bytes,
with path at most 4,096 UTF-8 bytes and every other string at most 512. Invalid UTF-8, duplicate/
unknown keys, noncanonical UUID/time/base64, unsafe number, non-JCS plaintext, or any bound excess is
local corruption requiring explicit uninstall/manual profile handling, never a partial parse or a helper attempt.

`envelope_sha256` is exactly lowercase
`SHA256(UTF8(JCS(complete ProfileCleanupJobEnvelopeV1)))`, including ciphertext and broker tag.
The file is owner-only, created no-follow/exclusive, flushed, renamed,
and directory-flushed under the same root rules as section 4.7.2. Before registration, the broker
commits `cleanup_job.state="prepared"` with the exact job ID and envelope hash in the matching
retired-profile record. The broker then installs an OS job
whose executable and arguments are fixed to the pinned helper plus opaque `installation_id` and
`job_id`; the absolute target is never an argument. The normalized registration descriptor contains
exactly the label, current-user owner identity, pinned helper absolute file identity/signature/hash,
the two fixed arguments, one-shot/run-at-load flags, and empty environment, working-directory,
stdin/stdout/stderr-override fields. Its JCS SHA-256 must equal
`registration_descriptor_sha256`. Verified OS-job registration is the external commit point
and is required before the disconnect result may say `scheduled`. After verifying registration, the
broker destroys every plaintext copy of the per-job key and queries the OS registration by its exact
job ID. It then commits the same link as `registered`; only then may it report `scheduled`. The
broker never possesses the cleanup-helper private
key. A crash before the protected `prepared` commit leaves an unlinked envelope that no helper may
execute. Registration failure proves registration absent and retains the authenticated envelope plus
`prepared` link for trusted retry; it never deletes the only record needed to finish requested cleanup.

On invocation the helper first queries the current-user job manager for that exact label and requires
one registration naming its own pinned executable plus the two argv identities; absence, duplicate
label, or direct/manual invocation fails before key unwrap. It verifies the broker HMAC, unwraps and
decrypts only enough to obtain the closed job, then requires the complete normalized live descriptor
to hash to its authenticated `registration_descriptor_sha256`; any altered executable, argument,
environment, working-directory, or output field fails before target access. It also revalidates its
own signature, internal file/key/job/grant/plan/profile consistency, time window, exact
normalized target beneath the recorded NAB-owned profile parent, both saved directory identities,
and Chrome process start identity, and proves that exact process has exited. It opens the saved parent
component-by-component under section 7.1 and never recursively resolves a string path. It opens the
target by basename with `openat(..., O_DIRECTORY|O_NOFOLLOW)`, compares device/inode (or the Windows
file-ID equivalent), rejects a mount point/reparse point, then atomically renames it within that same
parent/filesystem to the precommitted quarantine basename with no replacement and flushes both parent
handles. If the original name is absent after a crash, only a quarantine entry with the exact saved
identity is resumable; any state where both names exist or neither identity matches fails closed.

Before deletion it performs an fd/handle-relative full preflight. Every descendant is enumerated
from its already-open parent; `.`/`..`, slash-containing names, symlinks, reparse points, sockets,
devices, FIFOs, cross-device directories/mounts, identity changes, and regular files with link count
other than one are rejected. Deletion then repeats the same no-follow type/device/link/identity check
immediately before each `unlinkat`/platform equivalent, removes regular files only by parent handle,
removes child directories only after their handles are empty, and removes the quarantine root last.
It revalidates the saved parent and quarantine-root identities before each destructive batch. It
never follows a symlink, crosses a filesystem, deletes a hard-linked file, or broadens to an ancestor.

Success unregisters the job; the installation-scoped helper private/authentication keys remain until uninstall.
Any I/O/race/validation failure stops at the first failure and leaves the remaining exact quarantine
subtree plus authenticated job envelope for a trusted cleanup UI. Partial deletion is reported as
failure and never rolls back or claims completion. The one-shot OS invocation is unregistered after
either outcome and never automatically retries or retargets. After fresh user confirmation, the
trusted UI may revalidate the same unexpired envelope plus original/quarantine identity and
re-register exactly the same `(installation_id, job_id)` as a new one-shot invocation. If the
envelope expired, it may create a new job only from the matching encrypted `retired_profile` record
and deletes the old envelope after replacement registration commits. Manual helper launch is
rejected because the exact current registration is required; no caller can supply or retarget a path. After
a successful helper exit, the broker independently proves both original and quarantine names absent
under the saved parent, atomically clears `retired_profile`, and only then deletes the job envelope;
an exit code alone is not proof of deletion.

Startup enumerates at most 16 owner-only nonsymlink files matching the complete
`profile-cleanup.<canonical-uuid>.aead` grammar and at most 16 exact current-user job registrations
with the label prefix above; exceeding either bound is local corruption. It verifies broker HMACs
before decrypting. Reconciliation is closed:

| Protected link / envelope / registration / filesystem | Startup action |
| --- | --- |
| `prepared`, matching authenticated envelope, no registration, target/quarantine present | retain; trusted UI may register the exact descriptor, then commit `registered` |
| `prepared`, matching envelope and exact registration | verify descriptor and atomically roll the link forward to `registered` |
| `registered`, matching envelope and exact registration | leave scheduled; helper owns the attempt |
| `registered`, matching envelope, no registration, both original and quarantine absent | atomically clear retired profile, then delete envelope |
| `registered`, matching envelope, no registration, either saved identity still present | atomically downgrade to `prepared`; report prior failure and require trusted retry |
| authenticated unlinked envelope with no registration | pre-link orphan; delete only that exact generated file under the state lock |
| any unlinked registration, missing/mismatched envelope, wrong descriptor/link/identity, duplicate, or both names present | unregister when its exact label can be proved, retain the retired profile, publish no private socket, and require explicit uninstall/manual profile handling |

The broker verifies that the decrypted job's grant, plan, profile, path, parent/directory/process
identities, job ID, and envelope hash agree with the sole protected retired-profile link when it
prepares/registers/reconciles the job. The helper cannot read broker-only authority records and
relies on the broker HMAC plus exact live OS registration, not a claimed authority-index read. The helper never deletes the
envelope or authority index; the broker never infers success from registration disappearance alone.

The nonsecret state/rate keys and empty authority/rate records may remain after disconnect solely to
authenticate tombstones, browser-cleanup obligations, and installation-wide rate history. They grant
no CLI, browser, or provider authority. Explicit uninstall stops the broker and host, acquires the
lock, attempts pending browser/profile cleanup, deletes every grant/replay/cleanup/pairing/host key,
then the state/rate keys and manifest, deletes only validated generated files and the empty state
root/profile parent, and removes the fixed installation-metadata item last. If browser cleanup cannot run, uninstall must disclose that optional browser
permissions/profile data may remain; local file deletion is not represented as browser cleanup.

## 5. Page-snapshot adapter

The fixed MAIN-world function may access only:

```text
window.ynab.YNABSharedLib.defaultInstance.entityManager.getAllTransactions()
window.ynab.constants.TransactionSource
the build-pinned active-user/budget identity getters and minimum account/payee lookups named by the
  signed page-snapshot mode contract
read-only sync/freshness status properties
```

It MUST NOT call a sync, editor, store write, transition, import, matching, or change-set method.

Algorithm:

1. Confirm the frame is top-level and `location.origin` is exact.
2. Confirm the expected shared-library object, source enum, and method signatures exist, and require
   the observed web-build fingerprint to equal the signed page-mode build identity and the
   executing identity/extractor assets and accessor descriptor to match `adapter_assets` and
   `page_accessor_contract` asset and adjacent digest.
3. Snapshot the active user/plan identity, current sync/backfill-in-progress flags, the passive
   observer's raw completion state, and unsaved catalog/budget flags. If sync is active, wait up to
   exactly two seconds
   or return `PAGE_SYNC_IN_PROGRESS`; if unsaved changes exist return `PAGE_UNSAVED_CHANGES`; do not
   trigger or flush a sync.
4. Require `getAllTransactions()` to return the build-contracted random-access collection, read its
   safe-integer count before element access, and reject more than 100,000 total elements with
   `RESPONSE_TOO_LARGE`. Visit exactly those indexed elements once; never consume an unbounded
   iterator. Permit at most 10,000 distinct referenced account IDs and 10,000 distinct referenced
   payee IDs and perform only the minimum build-pinned lookups. The adapter has a two-second
   monotonic execution budget in addition to the sync wait; expiry discards the result as `TIMEOUT`.
5. Re-read every identity/sync/proof/unsaved value from step 3. Reject if identity changed, sync
   began, unsaved state appeared, the proof is invalid, or its success tick changed during
   extraction.
6. Filter into the closed internal projection in section 5.2; do not return page objects and do not
   receive any broker/service-worker key in MAIN world.
7. Validate again in the service worker, including the consent-bound plan and freshness ceiling.
8. Enforce the fixed 10,000-record ceiling and result JSON `<= 768 KiB`. This is a deliberately conservative
   product limit. The result travels Chrome-to-native-host, whose Chrome limit is 64 MiB; the
   opposite native-host-to-Chrome direction has the smaller 1 MiB Chrome limit.
9. Include the strict success-only completeness/freshness metadata from section 6.3.

### 5.1 Completeness proof

The adapter MUST NOT infer historical completeness merely because a page property currently says
`backfill_complete`, nor treat `_timeLastSyncedBudget` as a success timestamp: the reviewed client
sets that value before awaiting the request. A successful page snapshot requires a bridge-owned
proof assembled by a fixed, passive observer installed before the selected plan begins its
bootstrap/backfill sequence:

```ts
type PageObserverRawProofV1 = {
  version: 1;
  page_instance_id: string;             // random per top-level document
  raw_user_id: string;                   // bounded; erased by worker after fingerprinting
  raw_budget_id: string;
  raw_budget_version_id: string;         // exact identity observed for every completion
  web_build_fingerprint: string;
  api_version: string;
  catalog_schema: number;
  family_schema: number;
  budget_schema: number;
  bootstrap_succeeded_at: string;
  backfill_succeeded_at: string;
  last_budget_sync_succeeded_at: string;
  last_success_observer_tick: number;
  sync_failure_after_success: false;
};

// Service-worker-only derivative. MAIN never constructs this type or receives its HMAC key.
type PageCompletenessProofV1 = Omit<
  PageObserverRawProofV1,
  "raw_user_id" | "raw_budget_id" | "raw_budget_version_id"
> & {
  observed_account_fingerprint: string;
  observed_budget_fingerprint: string;
  observed_plan_fingerprint: string;
};
```

The observer is build-specific and read-only. It needs a provenance-named, externally subscribable
success signal whose payload distinguishes `bootstrap`, `backfill`, and `delta` and whose error
semantics are known. It timestamps one completed bootstrap followed by one completed backfill for
the same page instance, account, plan, build, and schema tuple. It may read reviewed exported state
or subscribe to an existing completion event, but may not wrap, replace, invoke, delay, or
acknowledge a sync. A later completed budget delta advances only the last-success timestamp/tick.

Current static evidence identifies internal sync methods, an `onApiRequestCompleted` method, and a
backfill-complete dispatch, but does not yet establish a safely subscribable public success signal
with the needed payload/error contract. Consequently the currently reviewed adapter MUST return
`PAGE_COMPLETENESS_UNPROVEN`; it MUST NOT manufacture this proof from
`_timeLastSyncedBudget`, current flags, or promise presence. This is an explicit implementation gate,
not an invitation to monkey-patch the page.

When a future signed mode contract names a usable signal, the managed dedicated profile must contain
exactly one top-level YNAB tab. The extension obtains explicit host permission and calls
`chrome.scripting.registerContentScripts` with exactly this read-back-equal object:

```json
{
  "id": "nab-ynab-page-observer-v1",
  "matches": ["https://app.ynab.com/*"],
  "js": ["page-observer-v1.js"],
  "allFrames": false,
  "world": "MAIN",
  "runAt": "document_start",
  "persistAcrossSessions": false
}
```

The packaged file path/hash must equal `adapter_assets.observer`; no other registration field or
registered script may exist. A `webNavigation` monitor covers every matching top-level commit in
that exact dedicated Chrome process from before registration until unregister proof. The extension
reloads only the selected tab, requires a new document ID plus a valid observer page-instance marker,
then immediately calls `unregisterContentScripts` and proves the ID absent. Any other matching tab/
document in that window aborts; the extension unregisters and closes every exact-origin tab in that
dedicated profile. Because the profile/Chrome process is provider-attested and NAB-owned, this
bounded enumeration is not a scan of ordinary user profiles. An
`activeTab` injection after load can never establish completeness. The MAIN observer keeps only the
raw proof above. At extraction, MAIN returns that raw proof plus bounded raw
user/budget/budget-version IDs;
the service worker first requires the proof's raw identities to equal the extraction identities,
then computes HMAC fingerprints with `identity_key`, compares the
grant binding, and constructs `PageCompletenessProofV1` in worker memory. Neither key nor expected
fingerprint crosses into MAIN.

Rollback, expiry, and disconnect first unregister that exact script ID and prove it absent, then
close every top-level tab whose current URL matches `https://app.ynab.com/*` in the exact attested
dedicated profile and prove a repeated `chrome.tabs.query` returns none. It also requires
`webNavigation.getFrame` for every saved target document to return null. Closing the document is the
hard observer teardown; no page-controlled acknowledgement is trusted. The operation is idempotent:
already-absent registration/tabs is success. API error, unclassified matching tab, profile/process
mismatch, or remaining document leaves the cleanup marker and forbids claiming completion. Host
permission is removed only afterward. Consent explicitly discloses that rollback/expiry/disconnect
closes YNAB tabs in the dedicated profile but does not log out or delete the profile.

Page identity and snapshot calls use exact `chrome.scripting.executeScript` objects with
`target:{tabId:target.tab_id,documentIds:[target.document_id]}`, `world:"MAIN"`, respectively
`files:["page-identity-probe-v1.js"]` or `files:["page-snapshot-extractor-v1.js"]`, and no other
fields. Packaged bytes match the corresponding asset hashes. Each call requires exactly one
InjectionResult with the same document ID/frame 0 and active lifecycle. Browser-catalog and native
capture use their separately signed stateful/accessor contracts but the same document-ID target
rule. Zero/multiple results, injection error, or another document/frame is a binding failure, never
permission to retry against a current tab.

Navigation, page reload, plan/account change, schema/build change, a later sync failure, observer
attachment after initialization began, a missing completion signal, or ambiguous ordering
invalidates the proof. The proof lives only in extension memory and is checked before and after
extraction. If the current reviewed build does not expose enough read-only state to construct it,
`page-snapshot` is unavailable. Because an `activeTab` grant obtained after page load is too late,
one-shot mode instructs the user to grant access and then reload/reopen the selected plan; if a
future validated observer exists and that does not happen, return `PAGE_RELOAD_REQUIRED`. Never
trigger a sync. The snapshot's `ynab_sync_age_ms` is the monotonic time elapsed since
`last_success_observer_tick`; the RFC 3339 values are display/audit metadata only.

Even with a valid proof, `page-snapshot` is complete only for the official client's hydrated,
post-normalization entity graph. It does not claim to preserve the pre-import `raw_pending` form.

### 5.2 MAIN-world-to-service-worker projection

MAIN world is untrusted and never receives `identity_key`, `reference_key`, expected fingerprints,
provider policy, or broker commands. The page-snapshot adapter may return only this internal value
to the service worker; browser-catalog has the separate wire outcome in section 10.3:

```ts
type BrowserPrivateTransactionProjectionV1 = {
  raw_transaction_id: string;
  raw_account_id: string;
  raw_matched_transaction_id: string | null;
  has_transfer_link: boolean;            // any transfer_* ID non-null
  payee_link_state: "none" | "resolved_nontransfer" | "resolved_transfer" | "dangling";
  has_live_subtransactions: boolean;
  source:
    | null
    | "Scheduler"
    | "raw_import"
    | "raw_pending"
    | "Imported"
    | "Pending"
    | "ImportedPending"
    | "Matched"
    | "matched_import"
    | "matched_pending";
  accepted: boolean;
  cleared: "Cleared" | "Uncleared" | "Reconciled";
  date: string;
  amount_milliunits_number: number;      // safe integer
  payee_name: string | null;
  imported_payee: string | null;
  provider_cleansed_payee: string | null;
  memo: string | null;
};

type BrowserPrivateAccountProjectionV1 = {
  raw_account_id: string;
  account_name: string | null;
};

type BrowserPrivateProjectionV1 = {
  schema: "nab.browser-private-projection/1";
  raw_user_id: string;
  raw_budget_id: string;
  raw_budget_version_id: string;
  observed_at: string;                  // MAIN candidate only; worker overwrites on acceptance
  control: {
    page_instance_id: string;
    web_build_fingerprint: string;
    api_version: string;
    catalog_schema: number;
    family_schema: number;
    budget_schema: number;
    sync_in_progress: boolean;
    backfill_in_progress: boolean;
    unsaved_catalog_changes: boolean;
    unsaved_budget_changes: boolean;
    observer_raw_proof: PageObserverRawProofV1 | null;
    extraction_started_observer_tick: number;
    extraction_finished_observer_tick: number;
    active_account_count: number;
    active_transaction_count: number;
    materialized_first_date: string | null;
    materialized_last_date: string | null;
  };
  accounts: BrowserPrivateAccountProjectionV1[];
  transactions: BrowserPrivateTransactionProjectionV1[];
};
```

The MAIN adapter includes every currently active materialized account, including accounts with zero
pending rows, in `accounts`; `active_account_count` is a safe non-negative integer and equals that
array's length. IDs are unique, each optional account name obeys the text limit, and every returned
transaction's required `raw_account_id` resolves exactly once in this array. Missing, tombstoned,
duplicate, or unresolvable account state is `PROTOCOL_CHANGED`. MAIN does not receive a caller
account filter; complete account projection is what lets the worker validate a supplied opaque
account reference without turning extraction into a caller-selected page query.

The MAIN adapter includes every pending-adjacent row, every live `Matched`, `matched_import`, and
`matched_pending` row, and every other live row with a non-null match ID needed to enforce the
closed relationship graph and prove or reject reciprocity. It determines
`has_live_subtransactions` only through the build-pinned transaction-child lookup/property named in
the signed page-snapshot mode contract, and `payee_link_state` only through that contract's exact
transaction payee ID, payee lookup, tombstone, and `entities_account_id` accessors; arbitrary
property traversal is forbidden. `payee_link_state="none"` means the contracted transaction payee
property is absent or explicitly null; a present non-null ID is always resolved and becomes
`resolved_nontransfer`, `resolved_transfer`, or `dangling`. It includes all
such rows even when a peer is absent so the worker can fail closed rather than silently omit a
possible pending match.
Before filtering, it validates the `source` of every active transaction against the complete current
closed enum `{null, Scheduler, raw_import, raw_pending, Imported, Pending, ImportedPending, Matched,
matched_import, matched_pending}`. Any other value fails the entire extraction with
`PROTOCOL_CHANGED`, even when that row has no match link and would otherwise be omitted. Thus a new
server-supplied pending source cannot disappear behind the filter. Tombstones still count toward the
100,000-element collection ceiling but are not source-classified as active rows.
It returns at most 1,000 unique active account IDs, at most 10,000 unique transaction IDs, and at
most 524,288 bytes of
UTF-8 JCS; per-ID/text/date/money limits from section 6.2 are checked before structured clone. The
service worker validates the closed schema, computes the observed account/budget/plan-version fingerprints with its
grant-bound `identity_key`, compares them to the bind context, derives transaction/account aliases
with `reference_key`, applies the exact lifecycle/operation/account/date/ref selection order in
catalog section 17, resolves each selected row and expanded hidden match peer against the complete
account projection, and takes
`account_name` only from that resolved account, applies lifecycle/dedup rules, and then overwrites/
discards every raw ID and
key-bearing intermediate before Native Messaging. A binding mismatch discards the projection and
returns `WRONG_ACCOUNT_OR_PLAN`. Exceeding either projection ceiling returns
`RESPONSE_TOO_LARGE`; rows are never truncated.
These 1,000-account/10,000-row/524,288-byte page-projection ceilings are additional pre-filter safety limits: they
apply to both `pending.list` and `pending.get` even when a caller filter or requested reference would
produce a small final result. Version 1 chooses global graph validation over selective extraction,
so a narrow query cannot bypass them.

The two extraction ticks use the observer's same monotonic clock, not the service worker's clock.
The worker requires safe integers with
`finished >= started >= observer_raw_proof.last_success_observer_tick` and requires the proof's
success tick and identity to be unchanged in the post-read snapshot. Page-snapshot
`ynab_sync_age_ms` is
`extraction_finished_observer_tick - last_success_observer_tick`; RFC timestamps remain display
metadata. The worker records its own monotonic tick immediately before invoking MAIN and again on
receipt. To avoid understating age across incomparable epochs, it seeds the accepted age as the MAIN
difference plus the complete worker invocation round trip, then adds later elapsed worker time from
the receipt tick. This conservatively double-counts some execution time but never compares the two
clock epochs; worker termination discards the snapshot. `active_transaction_count` is a safe
non-negative integer computed before pending
filtering. Its value is zero if and only if both materialized dates are null; otherwise both dates
are valid, first is not after last, and they are the minimum/maximum over every active transaction
enumerated from `getAllTransactions()`. Browser-catalog computes the same fields from its complete
materialized transaction map.

The page is an untrusted producer from the extension's point of view. A compromised page can forge
data returned by MAIN-world code; the service worker validates types and bindings but cannot make a
compromised origin honest.

## 6. Normalized pending contract

### 6.1 Lifecycle kinds

```ts
type PendingLifecycleKind =
  | "provider_pending"       // source Pending; visible pending section
  | "entered_provisional"   // source ImportedPending; entered into register, still provisional
  | "raw_staging"           // source raw_pending; hidden provider staging
  | "matched_provisional";  // visible Matched side whose hidden peer is matched_pending
```

`accepted` is reported independently. It MUST NOT be used as the definition of pending.
`Uncleared` is also independent: ordinary posted transactions may be uncleared.

Default `pending.list` is specified to return `provider_pending`, `raw_staging`, and
`matched_provisional`. The matched branch is a proposed fail-closed subset, not a verified current
server representation: it is enabled only when the selected mode's executable
`matched_pending_shape_contract` confirms the reciprocal winner/loser form below against the pinned
build. If any match-adjacent row is present without that contract, the whole query returns
`PROTOCOL_CHANGED`; it is not silently omitted. A
strict read-only catalog
reader can receive `raw_pending` before the ordinary web client's mutating import pass converts it
to `Pending`; excluding raw staging would make the direct-reader result incomplete. A normal,
quiescent page snapshot will usually contain the already-materialized `Pending` form instead.

A caller must explicitly request `entered_provisional`. A `matched_pending` entity is never emitted
as its own record. When its reciprocal visible peer is `Matched`, the normalizer emits the visible
peer once as `matched_provisional` and attaches the hidden entity only as typed lineage. Broken or
asymmetric relationships fail the whole query with `PROTOCOL_CHANGED`; they are neither emitted nor
silently double counted.

### 6.2 JSON model

All JSON fields use snake case. Monetary values are canonical base-10 strings, because JSON/Native
Messaging cannot carry JavaScript `bigint`.

`SecretString` below is a compile-time taint brand only:

```ts
type SecretString = string & { readonly __secret_string_brand: unique symbol };
```

Its wire representation is still a JSON string, validated against the operation-specific nonempty
UTF-8 byte ceiling (default 8,192 bytes), and it MUST be redacted/blocked from implicit logging,
serialization outside the named secret envelope, and exception formatting. JSON Schema represents
it as a constrained string; the brand never appears on the wire.

```ts
type PendingTransactionBaseV1 = {
  schema: "nab.pending-transaction/1";
  source_system: "ynab-web";
  private_entity_ref: string;          // opaque, scoped to plan; not a public mutation target
  public_transaction_id: null;
  accepted: boolean;
  cleared: "Cleared" | "Uncleared" | "Reconciled";
  public_account_id: null;
  private_account_ref: string;
  account_name: string | null;
  date: string;                         // valid YYYY-MM-DD full-date
  amount_milliunits: string;            // canonical safe-integer decimal; "-0" forbidden
  payee_name: string | null;
  imported_payee: string | null;
  provider_cleansed_payee: string | null;
  memo: string | null;
  capabilities: {
    public_get: false;
    public_update: false;
    private_read: true;
    private_write: false;
  };
  observed_at: string;                  // RFC 3339 UTC
};

type PendingTransactionV1 = PendingTransactionBaseV1 & (
  | {
      lifecycle: "provider_pending";
      source_value: "Pending";
      relationship: null;
      budget_effect: "none";
    }
  | {
      lifecycle: "raw_staging";
      source_value: "raw_pending";
      relationship: null;
      budget_effect: "none";
    }
  | {
      lifecycle: "entered_provisional";
      source_value: "ImportedPending";
      relationship: null;
      budget_effect: "entered";
    }
  | {
      lifecycle: "matched_provisional";
      source_value: "Matched";
      relationship: {
        kind: "pending_match";
        peer_private_ref: string;
        peer_source_value: "matched_pending";
        reciprocal: true;
      };
      budget_effect: "represented_by_match";
    }
);
```

Rules:

- `private_entity_ref` and `relationship.peer_private_ref` are opaque strings, never assumed UUIDs.
- `pending-read-v1` always sets both public IDs to `null` and both public capabilities to `false`.
  No general provider-defined private/public join is verified; neither raw `ynab_id` nor
  `matched_transaction_id` is promoted by itself. A future join is a new versioned profile with its
  own signed contract. Public mutations use a separate public-API command and fresh action-time
  authorization, never a bridge record as write authority.
- text may contain arbitrary Unicode but each field is capped at 4 KiB (4,096 bytes) UTF-8.
  Exceeding the limit
  fails the whole query with `RESPONSE_TOO_LARGE`; text is never truncated.
- dates and amounts are provisional.
- missing/invalid private account, date, amount, accepted, cleared, or lifecycle fields fail the
  whole query; the bridge never emits a partially typed pending record.
- lifecycle/budget-effect pairs are closed: provider/raw are `none`, entered provisional is
  `entered`, and matched provisional is `represented_by_match`; any other pair is a schema error.
- duplicate accounting is prevented: a hidden match side never contributes a second amount.
- any pending-adjacent row or its pending match peer with a transfer link,
  `payee_link_state="resolved_transfer"`, or a live subtransaction
  fails the whole query with `UNSUPPORTED_PENDING_SHAPE`; version 1 does not guess transfer/split
  accounting semantics.
- `payee_link_state="dangling"` on any selected pending-adjacent row/peer fails the whole query with
  `PROTOCOL_CHANGED`; absence of a payee entity cannot prove a non-transfer. `none` means the
  contracted transaction payee property is absent or explicitly null, not merely that display text
  was unavailable.

Every string MUST decode to a Unicode scalar-value sequence; lone UTF-16 surrogates are rejected.
The bridge preserves the original normalization form and counts bytes in UTF-8 over that scalar
sequence. Private/public/account/peer references are nonempty and at most 512 UTF-8 bytes; version
and fingerprint strings are at most 256 bytes; the amount string is at most 17 ASCII bytes, matches
`0|-[1-9][0-9]*|[1-9][0-9]*`, and when parsed exactly lies between
`-9007199254740991` and `9007199254740991` inclusive. Limits
are checked while building the normalized value so hostile page output cannot force an unbounded
intermediate structure.

The 768 KiB result ceiling means 786,432 bytes of UTF-8 JCS serialization of `result`, before the
broker envelope. The complete authenticated broker response and the complete Native Messaging frame
body must each be no more than 1,048,576 bytes. Every record's `observed_at` MUST equal its enclosing
snapshot's `observed_at` exactly.

Field derivation is deterministic:

| Output field | Source |
| --- | --- |
| `private_entity_ref` / `private_account_ref` | section 4.5 HMAC aliases over the selected transaction/account raw IDs |
| lifecycle/source/effect/relationship | closed source graph in sections 6.1–6.2; matched display fields always come from visible `Matched` |
| `accepted`, `cleared`, `date`, `amount_milliunits`, `memo`, import/payee text | the selected visible transaction projection; integer amount converted losslessly to canonical decimal |
| `account_name` | active referenced account's current name; null when the optional name is absent; a missing/tombstoned referenced account fails the query |
| `payee_name` | active referenced payee's current name; null for null/missing optional payee linkage or absent optional name |
| `observed_at` | enclosing projection/snapshot observation time |
| public IDs/capabilities | fixed null/false in `pending-read-v1`; a join requires a future profile |

For `matched_provisional`, the hidden peer contributes only its aliased reference and reciprocity
proof. Its date, payee, memo, and provider text never fill or override visible fields.

### 6.3 List result

```ts
type PendingListResultV1 = {
  schema: "nab.pending-list/1";
  plan_ref: string;
  records: PendingTransactionV1[];
  snapshot: {
    observed_at: string;
    ynab_sync_age_ms: number;
    sync_in_progress: false;
    bootstrap_complete: true;
    backfill_complete: true;
    complete_for_materialized_snapshot: true;
    materialized_first_date: string | null;
    materialized_last_date: string | null;
    provider_retention_guaranteed: false;
    source: "page-snapshot" | "browser-catalog";
  };
  warnings: "UNMAPPED_ACCOUNT"[];
  ordered_by: "date_desc_then_private_ref_asc";
};
```

`records` is deterministically ordered by valid full-date descending, then the raw UTF-8 byte order
of `private_entity_ref` ascending. Date filters are inclusive and `since_date` must not exceed
`until_date`.
The `private_account_ref` filter is exact and is accepted only when a constant-time comparison over
the aliases freshly derived for every currently active materialized account in the same grant finds
exactly one match. There is no “previously issued” reference registry and no acceptance based on a
past response; a deleted account's old alias stops matching. Zero/multiple matches return
`WRONG_ACCOUNT_OR_PLAN` without identifying another plan or raw account. Version 1 has no public-
account filter.
If `max_ynab_sync_age_seconds` is omitted, the grant's `max_ynab_sync_age_seconds` applies; a request may specify a
smaller value but never enlarge the grant. `include_entered_provisional` defaults to `false`.

`ynab_sync_age_ms` measures time since the YNAB client/catalog sync completed. It is not bank-feed
freshness; optional provider aggregation timestamps are separate evidence and are not converted into
a freshness guarantee.

This version has no pagination or silent truncation. After filtering and deduplication, more than
10,000 records or more than 768 KiB of serialized result produces `RESPONSE_TOO_LARGE` and no
partial result. These final-result limits do not replace a mode's earlier collection/cache/
projection ceilings; any earlier excess fails the whole query as specified by that mode. The
success proof is mode-specific. `page-snapshot` requires the exact executable
web-build, adapter, page-accessor, matched-shape, passive-success-signal, and passive-payload
contracts; the extractor must traverse the complete contracted transaction/account/payee/
subtransaction graph and reject every unknown lifecycle or relationship shape. It does not decode a
catalog response and therefore does not use a response-shape registry. `browser-catalog` requires
the exact executable response-shape registry and matched-shape contract: every registry-modeled
lifecycle/relationship must decode and every discarded field or collection must have provider-
attested no-pending/no-authority semantics. `native-replay` cannot produce a Version 1 success.
In both successful modes bootstrap/backfill are done, no sync overlaps either pre- or post-read
check, the last successful budget-sync timestamp is known and satisfies the age policy, and an
unknown/uncontracted member fails rather than being silently omitted. This does not promise that
YNAB retained every historical pending row: the first/last dates
bound the materialized transaction collection, and `provider_retention_guaranteed` remains false
until YNAB defines backfill retention. Otherwise the broker returns `PARTIAL_BACKFILL`,
`PAGE_SYNC_IN_PROGRESS`, `STALE_DATA`, or
`PROTOCOL_CHANGED`; it never disguises a partial result as success. `UNMAPPED_ACCOUNT` is a unique,
lexicographically ordered warning and does not omit the private account reference.

`materialized_first_date` and `materialized_last_date` are respectively the minimum and maximum
valid date over every active, non-tombstoned transaction in the fully materialized entity map before
pending classification or caller filters; both are null when that map has no active transaction.
They are not copied from `first_month`/`last_month` and do not prove provider retention. Emit exactly
one `UNMAPPED_ACCOUNT` warning if and only if at least one returned record has
`public_account_id = null`; an empty record set has no warning.

## 7. CLI-to-broker socket protocol

### 7.1 Transport

- POSIX: `AF_UNIX`, `SOCK_STREAM`; final runtime parent directory mode `0700` and socket-node mode
  `0600`, both owned by the effective user. Resolve the user's home/application-support directory
  with the account/OS API, not `$HOME`; walk from an already opened root handle using `openat`-style
  no-follow directory opens. Each ancestor must be either (a) root-owned, non-group/world-writable,
  and in the platform's fixed system-prefix allowlist, or (b) current-user-owned and
  non-group/world-writable. The final NAB runtime parent must additionally be exactly `0700`.
  Symlinks, sticky shared directories, ownership changes, mount/volume changes during the walk, and
  group/world-writable ancestors are rejected. Hold the owner-only single-instance lock there before
  creating or connecting to the socket. This intentionally permits ordinary root-owned `/` and
  `/Users`/`/home` ancestors without pretending that they are user-owned.
- Windows: current-user named pipe with an explicit DACL.
- Never TCP.
- Verify peer UID/SID and obtain peer PID plus non-reusable process-start identity from the kernel,
  never from the request. Before reading an authenticated operation and again before releasing a
  result, resolve that still-live process's executable file identity, hardened code signature/
  designated requirement, and release SHA-256 and require exact agreement with the grant/policy
  `nab_binary_fingerprint`. Before a grant, require the installer-paired CLI fingerprint; with a
  grant, the paired/grant/policy values must all agree. PID reuse, an interpreter/wrapper whose executed code cannot be bound,
  or unavailable peer-process attestation disables the bridge; pairing-key possession alone is not
  receiver identity. Windows uses named-pipe client PID/token plus Authenticode/file identity; a
  supported POSIX build uses the platform peer-PID API plus code-signature/file checks.
- One active browser/profile binding per broker connection.
- Maximum frame body: 1 MiB.
- Frame: unsigned 32-bit big-endian body length followed by UTF-8 JSON.
- Exactly one request and one response per connection; no pipelining, streaming, or unsolicited
  events. The client half-closes its write side after the request; the broker closes after flushing
  the response.
- Reject zero length, oversize, invalid UTF-8, duplicate JSON keys, trailing bytes, non-object root,
  or more than 32 levels of nesting.

### 7.2 Canonical authentication

The pairing key is the decoded 32 random bytes in the one fixed `PairingCredentialV1` item. The CLI
performs the exact direct lookup/re-read lifecycle in section 4.7.4; it never enumerates an epoch.
Requests and responses are authenticated independently:

1. Construct the request or response without `auth_tag`.
2. Canonicalize it with RFC 8785 JSON Canonicalization Scheme (JCS).
3. Compute `HMAC-SHA-256(pairing_key, UTF8(canonical_request))`.
4. Encode the 32-byte tag as unpadded base64url.
5. Compare in constant time.

Numbers in authenticated requests are restricted to safe non-negative integers; amounts are
strings. Duplicate keys are rejected before canonicalization.

The response tag covers its version, request ID, operation, success discriminator, and complete
result/error. Request pairing generation/epoch must equal the broker's paired steady-state manifest
and fixed item before replay insertion. Every authenticated response echoes that exact pair and the
client requires it to equal the credential used for its request. The client verifies the tag before
using any field. A frame that fails parsing or request
authentication is closed silently; the client maps that local condition to `BAD_FRAME` or
`AUTH_FAILED`, because an unauthenticated structured response would be an oracle.

`nonce` is 32 random bytes as unpadded base64url. `issued_at` and `expires_at` are RFC 3339 UTC with
at most millisecond precision. At the single accepted broker wall-time sample `now`, all three
inequalities must hold: `0 < expires_at - issued_at <= 30s`, `issued_at <= now + 5s`, and
`now < expires_at`. There is no post-expiry grace. A maximally future-skewed request can therefore
remain acceptable for strictly less than 35 seconds after a replay-store loss is detected. The
broker retains its nonce through `expires_at` and removes it only when `now >= expires_at`.

After framing/JSON/time/HMAC validation and before semantic validation, consent lookup, or browser
dispatch, the broker atomically inserts the nonce into one per-user replay store. One broker
single-instance lock and the shared store cover every worker process; an existing nonce is
`REPLAY_REJECTED`. A semantically invalid authenticated request still consumes its nonce.

Consumed nonces and exact expiry times are committed to an authenticated owner-only replay file before
the operation proceeds, then garbage-collected at/after expiry. On restart the broker loads
all unexpired entries. If that file is unavailable or fails authentication, the broker refuses
authenticated operations until 35 seconds after its recorded startup time or rotates/re-pairs the
pairing key; it never starts with an empty replay window under the old key.

Local pairing is an installer/OS-credential-store ceremony, not a broker operation and not an agent
capability. The broker socket is not published until both the signed CLI and broker can retrieve the
same access-controlled key. `bridge.ping` may run before a YNAB consent grant, but never before this
local pairing. A missing key is reported by the CLI locally; it does not create an unauthenticated
wire exchange.

### 7.3 Request envelope

```ts
type BrokerOperationV1 =
  | "bridge.ping"
  | "session.status"
  | "pending.list"
  | "pending.get"
  | "session.disconnect";

type BrokerRequestBaseV1 = {
  version: 1;
  pairing_generation: number;
  pairing_epoch: string;
  request_id: string;                  // UUIDv4
  issued_at: string;
  expires_at: string;
  nonce: string;
  auth_tag: string;
};

type BrokerRequestV1 =
  | (BrokerRequestBaseV1 & { operation: "bridge.ping"; params: EmptyParamsV1 })
  | (BrokerRequestBaseV1 & { operation: "session.status"; params: SessionStatusParamsV1 })
  | (BrokerRequestBaseV1 & { operation: "pending.list"; params: PendingListParamsV1 })
  | (BrokerRequestBaseV1 & { operation: "pending.get"; params: PendingGetParamsV1 })
  | (BrokerRequestBaseV1 & { operation: "session.disconnect"; params: DisconnectParamsV1 });
```

Operation parameters are closed schemas:

```ts
// JSON Schema: {type:"object", maxProperties:0, additionalProperties:false}.
type EmptyParamsV1 = Record<string, never> & { readonly __empty_params_brand?: never };

type SessionStatusParamsV1 = {
  plan_ref?: string;
};

type PendingListParamsV1 = {
  plan_ref: string;
  private_account_ref?: string;
  since_date?: string;
  until_date?: string;
  include_entered_provisional?: boolean;
  max_ynab_sync_age_seconds?: number;  // 0..86_400
};

type PendingGetParamsV1 = {
  plan_ref: string;
  private_entity_ref: string;
  include_entered_provisional?: boolean; // default false, same lifecycle policy as list
};

type DisconnectParamsV1 = {
  remove_optional_permissions: boolean;
  sign_out_dedicated_profile: boolean;
  delete_dedicated_profile: boolean;
};
```

Unknown parameters are rejected. `session.disconnect` is local state mutation and requires an
interactive, broker-owned user-presence confirmation; it is never an unattended agent capability.
After receiving a valid request, the broker opens a trusted local OS dialog that is not controllable
through this socket and displays the exact three booleans, plan reference, and deletion effects. A
one-use approval is bound to `(grant_id | null)`, any expired profile tombstone, request ID,
canonical params, and a 60-second deadline and is kept only in broker memory. Cancellation returns
`USER_CANCELLED`; absence/timeout returns `USER_PRESENCE_TIMEOUT`. No confirmation token exists in
agent-visible IPC. Disconnect always
deletes the consent grant, pairing key, normalized cache/cursors, and native-replay credential.
The three booleans control only the additional browser/profile actions.
Without a live grant/bound Native channel all three booleans MUST be false or the request is
`BAD_REQUEST`; browser cleanup is then performed from the extension's own trusted UI or a retained
expiry-cleanup marker, never through an unbound Native request.

### 7.4 Response envelope

```ts
type BridgePingResultV1 = {
  schema: "nab.bridge-ping/1";
  protocol_version: 1;
  broker_version: string;
  extension_connected: boolean;
};

type SessionStatusNoGrantBaseV1 = {
  schema: "nab.session-status/1";
  mode: null;
  plan_ref: null;
  granted_capabilities: [];
  consent_expires_at: null;
  ynab_sync_age_ms: null;
  provider_permission_present: null;
  pending_browser_cleanup: boolean;
  retry_after_ms: null;
};

type SessionStatusLiveBaseV1 = {
  schema: "nab.session-status/1";
  mode: "page-snapshot" | "browser-catalog" | "native-replay";
  plan_ref: string;
  granted_capabilities: ("pending.list" | "pending.get" | "session.status")[];
  consent_expires_at: string;
  pending_browser_cleanup: false;
};

type SessionStatusLiveOrdinaryStateV1 =
  | "browser_unavailable" | "page_not_ready" | "initializing" | "sync_in_progress"
  | "partial_backfill" | "reauth_required" | "permission_denied" | "protocol_update"
  | "capture_only_dispatch_disabled" | "capture_in_progress"
  | "session_state_unknown" | "read_result_unknown" | "ambiguous_commit"
  | "security_challenge" | "provider_unavailable" | "provider_error" | "quarantined";

type SessionStatusResultV1 =
  | (SessionStatusNoGrantBaseV1 & {
      state: "disconnected" | "consent_required" | "consent_expired";
    })
  | (SessionStatusLiveBaseV1 & {
      state: "provider_permission_missing";
      provider_permission_present: false;
      ynab_sync_age_ms: null;
      retry_after_ms: null;
    })
  | (SessionStatusLiveBaseV1 & {
      state: "rate_limited";
      provider_permission_present: true;
      ynab_sync_age_ms: null;
      retry_after_ms: number;            // safe non-negative integer
    })
  | (SessionStatusLiveBaseV1 & {
      state: "ready" | "stale";
      provider_permission_present: true;
      ynab_sync_age_ms: number;          // safe non-negative integer
      retry_after_ms: null;
    })
  | (SessionStatusLiveBaseV1 & {
      state: SessionStatusLiveOrdinaryStateV1;
      provider_permission_present: true;
      ynab_sync_age_ms: null;
      retry_after_ms: null;
    });

type PendingGetResultV1 = {
  schema: "nab.pending-get/1";
  plan_ref: string;
  record: PendingTransactionV1 | null;
  snapshot: PendingListResultV1["snapshot"];
};

const DISCONNECT_STEP_ORDER_V1 = [
  "stop_new_calls",
  "stop_browser_scheduler",
  "teardown_browser_mode",
  "delete_consent",
  "delete_binding_and_reference_keys",
  "delete_cache_and_cursors",
  "delete_native_credential",
  "remove_browser_permissions",
  "provider_logout",
  "install_profile_deletion_job",
  "close_browser",
  "delete_pairing",
  "delete_dedicated_profile"
] as const;

type DisconnectStepV1 = (typeof DISCONNECT_STEP_ORDER_V1)[number];

type DisconnectMandatoryStepV1 =
  | "stop_new_calls" | "stop_browser_scheduler" | "delete_consent"
  | "delete_binding_and_reference_keys" | "delete_cache_and_cursors"
  | "delete_native_credential" | "delete_pairing";

type DisconnectCompletedV1 = { status: "completed"; error_code: null; blocked_by: null };
type DisconnectFailedV1 = { status: "failed"; error_code: BridgeErrorCode; blocked_by: null };
type DisconnectBlockedV1 = {
  status: "blocked";
  error_code: null;
  blocked_by: DisconnectStepV1;
};

type DisconnectStepResultV1 =
  | ({ step: DisconnectMandatoryStepV1 } & (
      | DisconnectCompletedV1 | DisconnectFailedV1 | DisconnectBlockedV1
    ))
  | ({ step: "teardown_browser_mode" } & (
      | DisconnectCompletedV1 | DisconnectFailedV1 | DisconnectBlockedV1
      | { status: "not_applicable"; error_code: null; blocked_by: null }
    ))
  | ({
      step: "remove_browser_permissions" | "provider_logout" | "install_profile_deletion_job" |
        "close_browser";
    } & (
      | DisconnectCompletedV1 | DisconnectFailedV1 | DisconnectBlockedV1
      | { status: "not_requested"; error_code: null; blocked_by: null }
    ))
  | ({ step: "delete_dedicated_profile" } & (
      | DisconnectFailedV1 | DisconnectBlockedV1
      | { status: "scheduled" | "not_requested"; error_code: null; blocked_by: null }
    ));

type DisconnectResultV1 = {
  schema: "nab.disconnect/1";
  steps: DisconnectStepResultV1[];
  local_authority_revoked: boolean;
  provider_session_revocation: "confirmed" | "not_confirmed" | "not_requested";
};

type BrokerResponseBindingV1 = {
  pairing_generation: number;
  pairing_epoch: string;
};

type BrokerSuccessV1 = BrokerResponseBindingV1 & (
  | { version: 1; request_id: string; operation: "bridge.ping"; ok: true; result: BridgePingResultV1; auth_tag: string }
  | { version: 1; request_id: string; operation: "session.status"; ok: true; result: SessionStatusResultV1; auth_tag: string }
  | { version: 1; request_id: string; operation: "pending.list"; ok: true; result: PendingListResultV1; auth_tag: string }
  | { version: 1; request_id: string; operation: "pending.get"; ok: true; result: PendingGetResultV1; auth_tag: string }
  | { version: 1; request_id: string; operation: "session.disconnect"; ok: true; result: DisconnectResultV1; auth_tag: string }
);

type BrokerFailureV1 = {
  version: 1;
  pairing_generation: number;
  pairing_epoch: string;
  request_id: string;
  operation: BrokerOperationV1;
  ok: false;
  auth_tag: string;
  error: {
    code: BridgeErrorCode;
    message: string;                    // redacted, <= 512 UTF-8 bytes
    retryable: boolean;
    retry_after_ms: number | null;
  };
};

type BrokerResponseV1 = BrokerSuccessV1 | BrokerFailureV1;
```

`bridge.ping`, `session.status`, and single-shot `session.disconnect` may run after local pairing when
no live YNAB grant exists; only the two pending operations require a current grant. `session.status`
returns no provider or local secret. `pending.get` resolves only inside the consent-bound `plan_ref`; a missing,
tombstoned, posted, or non-pending reference returns `record = null` without revealing whether the
same opaque ID exists in another plan or collection.

`SessionStatusParamsV1.plan_ref` is selection, not discovery. Version 1 has at most one active grant,
so it MAY be omitted when that grant exists. With zero grants the ordinary no-grant/expired-tombstone
state is returned. More than one active grant is invalid durable state and quarantines the bridge;
it is not resolved by caller selection. When supplied, the reference must equal the active grant's
opaque reference (or the sole expired tombstone in the no-grant status path) in constant time. A
mismatch returns `WRONG_ACCOUNT_OR_PLAN` and does not reveal whether the reference appeared in prior
local state. In a no-grant cleanup-only state with no expired tombstone, a supplied value is ignored
and the output plan reference remains null; cleanup markers are not a plan-discovery surface.

`session.status` evaluates these conditions in order, stopping at the first match: (1) sole expired
grant tombstone with no live grant -> `consent_expired`; (2) no live grant and no authenticated
extension/native channel -> `disconnected`; (3) no live grant with such a channel ->
`consent_required`; (4) live grant with missing/invalid policy -> `provider_permission_missing`;
(5) live grant with `capture_cleanup_intent` -> `capture_in_progress`; (6) live grant without its
exact bound target/channel -> `browser_unavailable`; (7) retained terminal state; (8) the exact
page-state mapping below; (9) active provider/rate deadline with no usable snapshot ->
`rate_limited`; (10) stale; (11) ready. `disconnected` never describes a live
grant and `consent_required` never describes an expired tombstone. An unpaired CLI cannot
authenticate this protocol and reports that condition locally, outside `SessionStatusResultV1`.
For every no-grant branch, `mode`, `plan_ref`, and `consent_expires_at` are null,
`granted_capabilities` is empty, and both age/delay fields are null.
`provider_permission_present` is null in every no-grant branch because no authority-bearing policy
selector exists; in live branches it reports only the exact verified signed policy from section 4.4.
An existing cleanup marker does not change the no-grant state discriminator, but sets
`pending_browser_cleanup=true` and blocks new consent until resolved. `granted_capabilities` reports grant scope, not current usability; only
`state = "ready"` makes pending operations usable. `ynab_sync_age_ms` is non-null only for stale or
ready materialized state. `pending_browser_cleanup` is true if and only if the sole authenticated
`BrowserCleanupMarkerV1` exists, for any reason, and false if and only if it is absent. It never implies that a
credential or financial cache remains. `retry_after_ms` is a safe non-negative integer and non-null
if and only if `state = "rate_limited"`; it is the full remaining installation-wide dispatch
eligibility delay defined below, never a downward clamp. Zero is representable when the provider
returned a valid zero delay and every other deadline has already elapsed. A ready or stale in-memory snapshot remains `ready`/`stale` even when the next
background refresh is delayed. Lists are unique and lexicographically ordered.

Closed error union:

```ts
type BridgeErrorCode =
  | "BAD_FRAME"
  | "BAD_REQUEST"
  | "AUTH_FAILED"
  | "REPLAY_REJECTED"
  | "USER_CANCELLED"
  | "USER_PRESENCE_TIMEOUT"
  | "CONSENT_REQUIRED"
  | "CONSENT_EXPIRED"
  | "PROVIDER_PERMISSION_MISSING"
  | "BROWSER_UNAVAILABLE"
  | "PERMISSION_REQUIRED"
  | "NO_YNAB_TAB"
  | "WRONG_ORIGIN"
  | "WRONG_ACCOUNT_OR_PLAN"
  | "NOT_LOGGED_IN"
  | "PAGE_NOT_READY"
  | "PAGE_RELOAD_REQUIRED"
  | "PAGE_COMPLETENESS_UNPROVEN"
  | "PAGE_SYNC_IN_PROGRESS"
  | "PAGE_UNSAVED_CHANGES"
  | "STALE_DATA"
  | "PARTIAL_BACKFILL"
  | "UNSUPPORTED_PENDING_SHAPE"
  | "SESSION_EXPIRED"
  | "SESSION_STATE_UNKNOWN"
  | "READ_RESULT_UNKNOWN"
  | "PROTOCOL_CHANGED"
  | "SCHEMA_CHANGED"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "SECURITY_CHALLENGE"
  | "PROVIDER_ERROR"
  | "PERMISSION_DENIED"
  | "QUARANTINED"
  | "AMBIGUOUS_COMMIT"
  | "CAPTURE_IN_PROGRESS"
  | "RESPONSE_TOO_LARGE"
  | "TIMEOUT"
  | "INTERNAL";
```

`retryable` and `retry_after_ms` are not discretionary:

| Error class | `retryable` | Delay |
| --- | --- | --- |
| `PAGE_SYNC_IN_PROGRESS` | `true` | 250–2,000 ms, broker-selected |
| `RATE_LIMITED` | `true` | full non-negative remaining installation-wide dispatch-eligibility delay; raw provider component must be within signed `maximum_retry_after_ms` |
| `BROWSER_UNAVAILABLE`, transient `PAGE_NOT_READY` | `true` | non-null bounded broker suggestion |
| `TIMEOUT` proven to occur before any provider dispatch | `true` | non-null bounded broker suggestion |
| `STALE_DATA`, `PARTIAL_BACKFILL` | `false` | null; the bridge never triggers a private sync merely to satisfy the call |
| every other code, including `PAGE_RELOAD_REQUIRED`, `PAGE_COMPLETENESS_UNPROVEN`, `PAGE_UNSAVED_CHANGES`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `SECURITY_CHALLENGE`, `PERMISSION_DENIED`, `QUARANTINED`, `AMBIGUOUS_COMMIT`, and post-dispatch ambiguity | `false` | null |

Broker-generated suggestions are safe non-negative integer milliseconds no greater than
86,400,000. A provider delay may be larger but must remain a safe integer no greater than the signed
`maximum_retry_after_ms`; an excess is not clamped and becomes non-retryable `PROVIDER_ERROR`.
For `RATE_LIMITED`, the broker first commits every provider/cadence/rolling-window/quarantine
deadline, selects their exact maximum, and reports `max(0, selected_monotonic_deadline - now)`.
That effective value is bounded by the larger of `maximum_retry_after_ms` and 86,400,000 and may be
zero; it is not described as the raw header value. A caller
MUST NOT retry after the request expiry; it creates a new request ID/nonce/timestamps and still
honors broker/provider backoff. Authentication, identity, schema, or Castle failures require the
corresponding interactive or review transition, never an automated retry loop.

`TIMEOUT` exists only when the broker can prove that no provider request was dispatched. Any timeout,
connection loss, worker/port death, or cancellation after possible dispatch maps to
`READ_RESULT_UNKNOWN`, is non-retryable, and discards that logical device. A 5xx or other private
provider-unavailable response is non-retryable unless a written provider rule explicitly changes
that mapping.

Core sync states and provider failures map to the broker contract exactly as follows:

| Core condition/state | `session.status.state` | Operation error |
| --- | --- | --- |
| bootstrap/catalog/family/budget initialization active | `initializing` | `PAGE_NOT_READY` |
| ordinary sync active | `sync_in_progress` | `PAGE_SYNC_IN_PROGRESS` |
| bootstrap merged but backfill not committed | `partial_backfill` | `PARTIAL_BACKFILL` |
| ready and within age ceiling | `ready` | none |
| ready but outside age ceiling | `stale` | `STALE_DATA` |
| `REAUTH_REQUIRED` | `reauth_required` | `NOT_LOGGED_IN` before first login, otherwise `SESSION_EXPIRED` |
| budget read permission revoked | `permission_denied` | `PERMISSION_DENIED` |
| family read permission revoked but bound budget remains readable | unchanged budget state | none; family view is disabled |
| API/header incompatibility | `protocol_update` | `PROTOCOL_CHANGED` |
| document schema incompatibility | `protocol_update` | `SCHEMA_CHANGED` |
| `SESSION_STATE_UNKNOWN` | `session_state_unknown` | `SESSION_STATE_UNKNOWN` |
| `READ_RESULT_UNKNOWN` | `read_result_unknown` | `READ_RESULT_UNKNOWN` |
| `AMBIGUOUS_COMMIT` | `ambiguous_commit` | `AMBIGUOUS_COMMIT` |
| active signed/provider delay with no usable ready snapshot | `rate_limited` | `RATE_LIMITED` |
| provider security challenge | `security_challenge` | `SECURITY_CHALLENGE` |
| definitive provider/network unavailability with no approved later schedule | `provider_unavailable` | `PROVIDER_UNAVAILABLE` |
| `QUARANTINED` | `quarantined` | `QUARANTINED` |
| unknown redacted private application error | `provider_error` until the exact foreground provider-failure recovery contract succeeds | `PROVIDER_ERROR` |

`rate_limited` clears only when the recorded full deadline elapses and the broker timer begins a
permitted run. `provider_unavailable` and `provider_error` have no automatic timer under Version 1
and clear only through the non-null `recovery_contracts.provider_failure` foreground transition plus
its successful provider/identity probe while preserving rate history. An ordinary reconnect, sync,
or successful response outside that transition cannot clear either terminal state.
`security_challenge` clears only after the user completes the provider's ordinary challenge in the
dedicated UI and reconnects; the bridge never solves, suppresses, or synthesizes it.

`PERMISSION_REQUIRED` is reserved for a missing Chrome permission; it never represents a provider
authorization failure. A plan-binding mismatch maps to `WRONG_ACCOUNT_OR_PLAN`, not
`PERMISSION_DENIED`.

## 8. Chrome Native Messaging leg

### 8.1 Process ownership and broker control channel

The per-user NAB broker is the long-lived authority. It owns the CLI socket, consent/binding records,
replay store, provider policy, response HMAC, and public-ID enrichment. Chrome launches a separate,
short-lived Native Messaging host. That host is a stateless framing proxy; it never reads the CLI
pairing key and never asserts consent or provider permission.

At launch the host validates Chrome's supplied extension-origin argument against the single pinned
production origin, then connects outbound to a second broker-control Unix socket/named pipe. Its
POSIX parent/node modes and path checks equal section 7.1. Broker and host share the distinct
`host_broker_key` from section 4.7. They perform a mutual challenge/response and then wrap each
complete Native message in a separately bounded 2,097,152-byte host/broker frame.

The origin argv and possession of the installed host binary are not authentication: a same-user
process can manually launch that binary and forge argv. Before reading or writing a Native frame,
the host captures its direct parent PID plus non-reusable process-start identity, and both host and
broker independently obtain the same facts from OS process/peer-credential APIs. The broker learns
the host PID from the control socket/named-pipe peer, not from `host_hello`, then requires all of:

1. the peer is the pinned signed host executable at the installer-recorded file identity;
2. its still-live direct parent is a supported Chrome executable with the installer-recorded
   publisher/designated requirement, hardened code-signing validity, product identity, and path,
   and its version satisfies the signed provider policy minimum;
3. the parent relationship and both process-start identities are unchanged after inspection;
4. Chrome's origin argument is the one packaged extension ID allowed by the native-host manifest;
5. hello, consent, extension ID, attestation discriminator, and provider policy agree; when the mode
   requires managed runtime attestation, fresh evidence under the signed attestation contract binds
   this port challenge to the loaded package/profile/process tuple and equals the pinned release hash.

The broker revalidates host/parent liveness and process-start identities before accepting
`host_ready` and before each new grant bind; either process exit or PID reuse closes the channel.
Because Chrome enforces `allowed_origins` before it launches the child, the conjunction of a direct,
attested Chrome parent and the pinned native-host manifest excludes manual same-user launch. It
authenticates an extension origin/ID, not extension package bytes; the separate section 4.4
attestation rule is therefore mandatory and a hello fingerprint is never trusted by itself. A
platform that cannot let the broker attest the socket peer, direct parent, executable signature,
and process-start identity cannot enable any Chrome-backed mode. The OS-secret ACL still permits only
the reviewed signed broker and host, but it is defense in depth rather than a substitute for this
launch attestation or extension-package proof. For a dedicated profile, the broker additionally requires that the attested
Chrome process be the exact process-start identity in its launcher record and that the launch
configuration names the saved NAB-owned profile directory. For a selected existing profile, Chrome
exposes no independently verifiable profile identity to the native host: `profile_instance` is an
opaque extension assertion used only for anti-confusion under the extension-ID/publisher boundary,
never proof of a filesystem profile.

```ts
type HostBrokerHelloV1 = {
  version: 1;
  type: "host_hello";
  host_instance_id: string;
  extension_origin: string;
  host_challenge: string;
  issued_at: string;
  auth_tag: string;
};

type HostBrokerHelloAckV1 = {
  version: 1;
  type: "broker_hello_ack";
  host_instance_id: string;
  broker_instance_id: string;
  host_challenge: string;
  broker_challenge: string;
  issued_at: string;
  auth_tag: string;
};

type HostBrokerReadyV1 = {
  version: 1;
  type: "host_ready";
  host_instance_id: string;
  broker_instance_id: string;
  broker_challenge: string;
  auth_tag: string;
};

type HostBrokerFrameV1 = {
  version: 1;
  host_instance_id: string;             // UUIDv4 chosen by host
  broker_instance_id: string;           // UUIDv4 learned in handshake
  direction: "chrome_to_broker" | "broker_to_chrome";
  sequence: number;                      // starts at 1 per direction; strictly increases
  payload: NativeMessageV1;
  auth_tag: string;                      // HMAC-SHA-256/JCS, key distinct from CLI key
};

type HostBrokerControlMessageV1 =
  | HostBrokerHelloV1 | HostBrokerHelloAckV1 | HostBrokerReadyV1 | HostBrokerFrameV1;
```

Every `auth_tag` is unpadded base64url HMAC-SHA-256 over UTF-8
`"nab-host-broker-v1\0" || JCS(message_without_auth_tag)`. The host sends `host_hello`; within five
seconds the broker validates it and returns the echoing ack plus its challenge; within five seconds
the host returns `host_ready`. Challenges are 32 random bytes, single use, and the broker consumes the
host challenge before its ack; the host atomically consumes the broker challenge when validating and
sending `host_ready`. Data sequences begin only after ready. A mismatch,
duplicate/gap, role-cardinality violation, or control-channel loss closes the affected Chrome and
broker-control legs and enters the role-specific failure transition below.
The proxy validates framing/size and relays the closed `NativeMessageV1` union only. The broker
validates its semantics, composes broker-owned fields, and alone authenticates CLI responses.
The 2,097,152-byte control limit counts the complete UTF-8 JCS `HostBrokerControlMessageV1` body
before any local stream framing. The receiver checks a fixed-width length before allocation; this
larger outer limit is intentional because `HostBrokerFrameV1` adds fields and an HMAC around the
already bounded Native payload.

Each host/broker control frame is an unsigned 32-bit big-endian length followed by exactly that many
bytes of RFC 8785 JCS UTF-8. Length must be `1..2,097,152`. The receiver rejects the length before
allocation, invalid UTF-8, duplicate keys, non-JCS bytes, unknown/missing fields, trailing JSON
tokens, premature EOF, or bytes between frames. Handshake frames occur one at a time in the order
`host_hello`, `broker_hello_ack`, `host_ready`; afterward complete data frames may be pipelined only
in their independently contiguous per-direction sequence. EOF in a frame is fatal; clean EOF is
valid only between frames after the role's close transition. A writer writes the entire prefix/body
under one per-direction mutex and never interleaves two frames.

Host cardinality is role-based because Chrome launches one native-host process per
`connectNative` port. Per bound browser-profile instance the broker permits exactly zero or one
`active_data` host or one mutually exclusive transient host with role `candidate_probe` or
`credential_capture`. A new connection
with no active grant is the one `candidate_probe`. Renewal first stops new calls, drains/closes the
old active host, and resolves every permit/outcome before accepting the candidate-probe hello or any
preparation mutation; candidate-probe and active-data never coexist. After activation the broker
atomically promotes the still-open candidate role to `active_data`; there is never a moment with two
active data hosts. Credential capture may coexist with one active-data host only during the exact
five-second native-replay handoff: new data calls and scheduling are stopped, the old host has
acknowledged a definitive drain, the capture hello is freshly attested, and the broker commits
`capture_cleanup_intent` before deliberately closing/proving absent the old port. No data/control
frame is legal during coexistence; failure runs forward retirement. The capture host cannot be
promoted or carry a catalog dispatch. Normally, `permission_cleanup` is the sole host for that
profile and requires no active/transient host. The sole exception is the at-most-five-second
terminal cleanup handoff after capture retirement: active authority, challenge, and staged seed are
already absent; the old `credential_capture` host is terminal-only; and exactly one matching cleanup
hello may be queued without an ack, challenge, or cleanup authority. The broker promotes that queue
only after the old capture host is definitively absent. Timeout/ambiguity closes the queue and keeps
the marker. A second host of the same role,
both transient roles together, a role change other than candidate promotion, or profile/target
aliasing closes the newcomer and treats any possibly dispatched active operation under its ordinary
ambiguity rule; it does not indiscriminately close an unrelated proven-idle active host.

### 8.2 Chrome framing and messages

Chrome frames each message as native-endian unsigned 32-bit length plus UTF-8 JSON. The native host
MUST reserve stdout exclusively for frames and write sanitized diagnostics to stderr. Chrome limits
native-host-to-Chrome messages to 1 MiB and Chrome-to-host messages to 64 MiB; this protocol imposes
the smaller 1,048,576-byte application limit in both directions. The limit counts the UTF-8 JSON
body and excludes the four-byte prefix; the receiver rejects the declared length before allocating
or reading that body. Windows sets stdin/stdout to binary mode.

The Chrome leg does not reuse the CLI socket HMAC: Chrome starts the exact allowlisted native host
and the native-host manifest pins the packaged extension origin. It uses this closed envelope:

```ts
type NativeHelloV1 = {
  version: 1;
  type: "hello";
  port_nonce: string;                    // 32 random bytes, unpadded base64url
  extension_version: string;
  extension_package_fingerprint: string;
  profile_instance: string;
} & (
  | {
      purpose: "connect_probe";
      selected_target: BrowserTargetBindingV1;
    }
  | {
      purpose: "credential_capture";
      selected_target: BrowserTargetBindingV1;
      worker_instance_id: string;       // fresh UUIDv4 for this attested worker instance
    }
  | {
      purpose: "permission_cleanup";
      selected_target: null;
      worker_instance_id: string;       // fresh/current runtime-attested worker UUIDv4
    }
);

type NativeHelloAckV1 = {
  version: 1;
  type: "hello_ack";
  port_nonce: string;                    // exact echo
  host_instance_id: string;              // random UUIDv4 for this process
  broker_protocol_version: 1;
} & (
  | { purpose: "credential_capture"; capture_listener_epoch: string }
  | { purpose: "connect_probe" | "permission_cleanup"; capture_listener_epoch: null }
);

type NativeBindGrantBaseV1 = {
  version: 1;
  type: "bind_grant";
  port_nonce: string;
  sequence: 4;                          // broker direction after preparation, probe, receipt
  grant_id: string;
  plan_ref: string;
  target: BrowserTargetBindingV1;
  extension_attestation: ConsentGrantV1["extension_attestation"];
  expected_account_fingerprint: string;
  expected_budget_fingerprint: string;
  expected_plan_fingerprint: string;
  api_version: string;
  catalog_schema: number;
  family_schema: number;
  budget_schema: number;
  granted_capabilities: ("pending.list" | "pending.get" | "session.status")[];
  max_ynab_sync_age_seconds: number;
  minimum_refresh_interval_ms: number;          // exact signed-policy value
  maximum_requests_per_hour: number;
  maximum_retry_after_ms: number;
  maximum_initialization_requests: number;     // zero for page-snapshot
  maximum_refresh_requests: number;            // zero for page-snapshot
  cache_limits: ProviderAuthorizationPolicyV1["cache_limits"];
  parser_limits: ProviderAuthorizationPolicyV1["parser_limits"];
  mode_contract_sha256: string;
  authorization_expires_at: string;             // min(consent expiry, policy expiry)
  identity_key: SecretString;             // per-grant fingerprint key; service worker only
  reference_key: SecretString;            // per-grant alias key; not a provider credential
};

type NativeBindGrantV1 = NativeBindGrantBaseV1 & (
  | {
      mode: "page-snapshot";
      execution: "page_read_only";
      mode_contract: Extract<ProviderModeContractV1, { mode: "page-snapshot" }>;
      maximum_initialization_requests: 0;
      maximum_refresh_requests: 0;
    }
  | {
      mode: "browser-catalog";
      execution: "browser_catalog_read_only";
      mode_contract: Extract<ProviderModeContractV1, { mode: "browser-catalog" }>;
    }
  | {
      mode: "native-replay";
      execution: "capture_only_dispatch_disabled";
      mode_contract: Extract<ProviderModeContractV1, { mode: "native-replay" }>;
    }
);

type NativeBindAckV1 = {
  version: 1;
  type: "bind_ack";
  port_nonce: string;
  sequence: 3;                          // worker direction after target-ready + probe outcome
  grant_id: string;
  ok: true;
};

type NativePreparationArmedV1 = {
  version: 1;
  type: "preparation_armed";
  port_nonce: string;
  sequence: 1;
  preparation_id: string;
  provisional_grant_id: string;
  requested_mode: "page-snapshot" | "browser-catalog" | "native-replay";
  pre_reload_target: BrowserTargetBindingV1;
  page_observer_scope: Extract<PageObserverCleanupV1, { phase: "registration_scope" }> | null;
  browser_realm_scope: Extract<BrowserRealmCleanupV1, { phase: "preparation_scope" }> | null;
  browser_mutation_allowed: true;
};

type NativePreparationTargetReadyV1 = {
  version: 1;
  type: "preparation_target_ready";
  port_nonce: string;
  sequence: 1;
  preparation_id: string;
  provisional_grant_id: string;
  target: BrowserTargetBindingV1;
  page_instance_id: string | null;
  browser_realm_adapter_instance_id: string | null;
};

type NativeConnectProbeBeginV1 = {
  version: 1;
  type: "connect_probe_begin";
  port_nonce: string;
  sequence: 2;
  probe_id: string;
  challenge: string;
  accept_before: string;
  target: BrowserTargetBindingV1;
  requested_mode: "page-snapshot" | "browser-catalog" | "native-replay";
  candidate_identity_key: SecretString;  // service-worker memory only
};

type NativeStopAndDrainV1 = {
  version: 1;
  type: "stop_and_drain";
  port_nonce: string;
  sequence: number;
  request_id: string;
};

type NativeStopAndDrainAckV1 = {
  version: 1;
  type: "stop_and_drain_ack";
  port_nonce: string;
  sequence: number;
  request_id: string;
  dispatch_state: "none_in_flight" | "definitive_outcome_committed" | "ambiguous_device_destroyed";
};

type NativeSchedulerRunV1 = {
  version: 1;
  type: "scheduler_run";
  port_nonce: string;
  control_sequence: number;             // broker->worker control sequence
  run_id: string;
  kind: "initialize" | "refresh";
  burst_reservation_id: string;
  reserved_slots: number;               // exact signed maximum for this run kind
  run_not_after: string;                 // reservation time + exactly 120 seconds
};

type NativeDispatchReserveV1 = {
  version: 1;
  type: "dispatch_reserve";
  port_nonce: string;
  control_sequence: number;             // worker->broker control sequence
  run_id: string;
  burst_reservation_id: string;
  logical_request_id: string;
  operation: "getInitialUserData" | "syncCatalogData" | "syncFamilyData" | "syncBudgetData";
  ordinal: number;
  sync_type: null | "bootstrap" | "backfill" | "delta";
};

type NativeDispatchPermitV1 = {
  version: 1;
  type: "dispatch_permit";
  port_nonce: string;
  control_sequence: number;
  run_id: string;
  burst_reservation_id: string;
  logical_request_id: string;
  reservation_id: string;
  operation: NativeDispatchReserveV1["operation"];
  ordinal: number;
  sync_type: NativeDispatchReserveV1["sync_type"];
  dispatch_before: string;              // broker wall deadline <= 5 seconds
};

type NativeDispatchDenyBaseV1 = {
  version: 1;
  type: "dispatch_deny";
  port_nonce: string;
  control_sequence: number;
  run_id: string;
  burst_reservation_id: string;
  logical_request_id: string;
  operation: NativeDispatchReserveV1["operation"];
  ordinal: number;
  sync_type: NativeDispatchReserveV1["sync_type"];
};

type NativeDispatchDenyV1 = NativeDispatchDenyBaseV1 & (
  | {
      error_code: "RATE_LIMITED";
      retry_after_ms: number;            // safe non-negative integer, exact remaining full deadline
      device_disposition: "retain_without_dispatch";
    }
  | {
      error_code: "CONSENT_EXPIRED" | "PROVIDER_PERMISSION_MISSING";
      retry_after_ms: null;
      device_disposition: "destroy";
    }
);

type NativeDispatchDecisionV1 = NativeDispatchPermitV1 | NativeDispatchDenyV1;

type NativeDispatchOutcomeBaseV1 = {
  version: 1;
  type: "dispatch_outcome";
  port_nonce: string;
  control_sequence: number;
  run_id: string;
  burst_reservation_id: string;
  reservation_id: string;
  logical_request_id: string;
  operation: NativeDispatchReserveV1["operation"];
};

type NativeDispatchOutcomeV1 = NativeDispatchOutcomeBaseV1 & (
  | { outcome: "success"; error_code: null; retry_after_ms: null }
  | { outcome: "definitive_failure"; error_code: "RATE_LIMITED"; retry_after_ms: number }
  | {
      outcome: "definitive_failure";
      error_code: Exclude<BrowserErrorCodeV1, "RATE_LIMITED" | "DISPATCH_OUTCOME_UNKNOWN" |
        "SESSION_ROTATION_UNKNOWN" | "WRITE_GUARD_VIOLATION">;
      retry_after_ms: null;
    }
  | {
      outcome: "dispatch_ambiguous";
      operation: "getInitialUserData";
      error_code: "SESSION_ROTATION_UNKNOWN";
      retry_after_ms: null;
    }
  | {
      outcome: "dispatch_ambiguous";
      operation: "syncCatalogData" | "syncFamilyData" | "syncBudgetData";
      error_code: "DISPATCH_OUTCOME_UNKNOWN";
      retry_after_ms: null;
    }
  | {
      outcome: "dispatch_ambiguous";
      error_code: "WRITE_GUARD_VIOLATION";
      retry_after_ms: null;
    }
  | { outcome: "permit_expired_unused"; error_code: "TIMEOUT"; retry_after_ms: null }
);

type NativeDispatchOutcomeAckV1 = {
  version: 1;
  type: "dispatch_outcome_ack";
  port_nonce: string;
  control_sequence: number;
  reservation_id: string;
};

type NativeSchedulerRunResultBaseV1 = {
  version: 1;
  type: "scheduler_run_result";
  port_nonce: string;
  control_sequence: number;
  run_id: string;
  burst_reservation_id: string;
  kind: "initialize" | "refresh";
};

type NativeSchedulerRunResultV1 = NativeSchedulerRunResultBaseV1 & (
  | { result: "ready"; error_code: null }
  | {
      result: "definitive_failure";
      error_code: Exclude<BrowserErrorCodeV1, "DISPATCH_OUTCOME_UNKNOWN" |
        "SESSION_ROTATION_UNKNOWN" | "WRITE_GUARD_VIOLATION"> |
        "CONSENT_EXPIRED" | "PROVIDER_PERMISSION_MISSING";
    }
  | {
      result: "ambiguous_device_destroyed";
      kind: "initialize";
      error_code: "DISPATCH_OUTCOME_UNKNOWN" | "SESSION_ROTATION_UNKNOWN" |
        "WRITE_GUARD_VIOLATION";
    }
  | {
      result: "ambiguous_device_destroyed";
      kind: "refresh";
      error_code: "DISPATCH_OUTCOME_UNKNOWN" | "WRITE_GUARD_VIOLATION";
    }
);

type NativeConnectProbeSuccessV1 = {
  version: 1;
  type: "connect_probe_result";
  ok: true;
  port_nonce: string;
  sequence: 2;
  probe_id: string;
  challenge: string;
  target: BrowserTargetBindingV1;
  observed_account_fingerprint: string;
  observed_budget_fingerprint: string;
  observed_plan_fingerprint: string;
  account_display_label: string;
  plan_display_label: string;
  web_build_fingerprint: string;
  api_version: string;
  catalog_schema: number;
  family_schema: number;
  budget_schema: number;
};

type NativeConnectProbeFailureV1 = {
  version: 1;
  type: "connect_probe_result";
  ok: false;
  port_nonce: string;
  sequence: 2;
  probe_id: string;
  challenge: string;
  target: BrowserTargetBindingV1;
  error: {
    code:
      | "BROWSER_UNAVAILABLE"
      | "PERMISSION_REQUIRED"
      | "NO_YNAB_TAB"
      | "WRONG_ORIGIN"
      | "NOT_LOGGED_IN"
      | "PAGE_NOT_READY"
      | "PROTOCOL_CHANGED"
      | "RESPONSE_TOO_LARGE"
      | "INTERNAL";
    message: string;                    // fixed code-derived literal, <= 512 UTF-8 bytes
  };
};

type NativeConnectProbeOutcomeV1 = NativeConnectProbeSuccessV1 | NativeConnectProbeFailureV1;

type NativeConnectProbeReceiptV1 = {
  version: 1;
  type: "connect_probe_receipt";
  port_nonce: string;
  sequence: 3;
  probe_id: string;
} & (
  | { ok: true; candidate_committed: true; error: null }
  | { ok: false; candidate_committed: false; error: BrokerFailureV1["error"] }
);

type NativeGrantActivatedV1 = {
  version: 1;
  type: "grant_activated";
  port_nonce: string;
  sequence: 5;
  grant_id: string;
  activation: "candidate_activated";
};

type NativeGrantActivatedAckV1 = {
  version: 1;
  type: "grant_activated_ack";
  port_nonce: string;
  sequence: 4;
  grant_id: string;
};

type ExtensionOperationV1 =
  | "session.status"
  | "pending.list"
  | "pending.get"
  | "session.disconnect";

type NativeRequestBaseV1 = {
  version: 1;
  type: "request";
  port_nonce: string;
  sequence: number;                      // broker direction starts at 6; safe integer; strictly increasing
  request_id: string;                    // copied from authenticated broker request
};

type BrowserSessionStatusParamsV1 = Record<string, never>;
type BrowserPendingListParamsV1 = Omit<PendingListParamsV1, "plan_ref">;
type BrowserPendingGetParamsV1 = Omit<PendingGetParamsV1, "plan_ref">;

type NativeRequestV1 =
  | (NativeRequestBaseV1 & { operation: "session.status"; params: BrowserSessionStatusParamsV1 })
  | (NativeRequestBaseV1 & { operation: "pending.list"; params: BrowserPendingListParamsV1 })
  | (NativeRequestBaseV1 & { operation: "pending.get"; params: BrowserPendingGetParamsV1 })
  | (NativeRequestBaseV1 & { operation: "session.disconnect"; params: DisconnectParamsV1 });

type BrowserPageStateV1 =
  | "no_tab" | "wrong_origin" | "not_logged_in" | "not_ready"
  | "reload_required" | "completeness_unproven" | "sync_in_progress"
  | "unsaved_changes" | "initializing" | "partial_backfill" | "ready" | "stale"
  | "reauth_required" | "permission_denied" | "protocol_changed" | "schema_changed"
  | "security_challenge" | "quarantined";

type BrowserStatusProbeBaseV1 = {
  schema: "nab.browser-status-probe/1";
  target: BrowserTargetBindingV1;
  source: "page-snapshot" | "browser-catalog";
};

type BrowserStatusProbeV1 = BrowserStatusProbeBaseV1 & (
  | {
      page_state: "ready" | "stale";
      observed_account_fingerprint: string;
      observed_budget_fingerprint: string;
      observed_plan_fingerprint: string;
      ynab_sync_age_ms: number;          // safe non-negative integer
    }
  | {
      page_state: Exclude<BrowserPageStateV1, "ready" | "stale">;
      observed_account_fingerprint: null;
      observed_budget_fingerprint: null;
      observed_plan_fingerprint: null;
      ynab_sync_age_ms: null;
    }
);

type BrowserPendingTransactionV1 = PendingTransactionV1 & {
  public_transaction_id: null;
  public_account_id: null;
  capabilities: {
    public_get: false;
    public_update: false;
    private_read: true;
    private_write: false;
  };
};

type BrowserPendingListPayloadV1 = {
  schema: "nab.browser-pending-list/1";
  observed_account_fingerprint: string;
  observed_budget_fingerprint: string;
  observed_plan_fingerprint: string;
  records: BrowserPendingTransactionV1[];
  snapshot: PendingListResultV1["snapshot"] & {
    source: "page-snapshot" | "browser-catalog";
  };
  ordered_by: "date_desc_then_private_ref_asc";
};

type BrowserPendingGetPayloadV1 = {
  schema: "nab.browser-pending-get/1";
  observed_account_fingerprint: string;
  observed_budget_fingerprint: string;
  observed_plan_fingerprint: string;
  record: BrowserPendingTransactionV1 | null;
  snapshot: PendingListResultV1["snapshot"] & {
    source: "page-snapshot" | "browser-catalog";
  };
};

type BrowserDisconnectCompletedV1 = { status: "completed"; error_code: null };
type BrowserTeardownDisconnectResultV1 =
  | BrowserDisconnectCompletedV1
  | { status: "not_applicable"; error_code: null }
  | {
      status: "failed";
      error_code: "BROWSER_UNAVAILABLE" | "PROTOCOL_CHANGED" | "TIMEOUT" | "INTERNAL";
    };
type BrowserPermissionDisconnectResultV1 =
  | BrowserDisconnectCompletedV1
  | { status: "not_requested"; error_code: null }
  | {
      status: "failed";
      error_code: "BROWSER_UNAVAILABLE" | "PERMISSION_REQUIRED" |
        "PROTOCOL_CHANGED" | "TIMEOUT" | "INTERNAL";
    };
type BrowserLogoutDisconnectResultV1 =
  | BrowserDisconnectCompletedV1
  | { status: "not_requested"; error_code: null }
  | {
      status: "failed";
      error_code: "BROWSER_UNAVAILABLE" | "PROVIDER_PERMISSION_MISSING" | "SESSION_EXPIRED" |
        "PROVIDER_UNAVAILABLE" | "PROTOCOL_CHANGED" | "TIMEOUT" | "INTERNAL";
    };

type BrowserDisconnectResultV1 = {
  schema: "nab.browser-disconnect/1";
  teardown_browser_mode: BrowserTeardownDisconnectResultV1;
  remove_browser_permissions: BrowserPermissionDisconnectResultV1;
  provider_logout: BrowserLogoutDisconnectResultV1;
  provider_session_revocation: "confirmed" | "not_confirmed" | "not_requested";
};

type NativeResponseBaseV1 = {
  version: 1;
  type: "response";
  port_nonce: string;
  sequence: number;                      // worker direction starts at 5
  request_id: string;
};

type BrowserErrorCodeV1 =
  | "BROWSER_UNAVAILABLE" | "PERMISSION_REQUIRED" | "NO_YNAB_TAB" | "WRONG_ORIGIN"
  | "WRONG_ACCOUNT_OR_PLAN" | "NOT_LOGGED_IN" | "PAGE_NOT_READY"
  | "PAGE_RELOAD_REQUIRED" | "PAGE_COMPLETENESS_UNPROVEN" | "PAGE_SYNC_IN_PROGRESS"
  | "PAGE_UNSAVED_CHANGES" | "STALE_DATA" | "PARTIAL_BACKFILL" | "SESSION_EXPIRED"
  | "UNSUPPORTED_PENDING_SHAPE"
  | "PROTOCOL_CHANGED" | "SCHEMA_CHANGED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_ERROR" | "PERMISSION_DENIED" | "QUARANTINED" | "RESPONSE_TOO_LARGE"
  | "TIMEOUT" | "SECURITY_CHALLENGE" | "DISPATCH_OUTCOME_UNKNOWN"
  | "SESSION_ROTATION_UNKNOWN" | "WRITE_GUARD_VIOLATION" | "INTERNAL";

type BrowserFailureV1 = {
  code: BrowserErrorCodeV1;
  message: string;                       // fixed code-derived text, <= 512 UTF-8 bytes
  retryable: boolean;
  retry_after_ms: number | null;
};

type NativeResponseV1 =
  | (NativeResponseBaseV1 & { operation: "session.status"; ok: true; result: BrowserStatusProbeV1 })
  | (NativeResponseBaseV1 & { operation: "pending.list"; ok: true; result: BrowserPendingListPayloadV1 })
  | (NativeResponseBaseV1 & { operation: "pending.get"; ok: true; result: BrowserPendingGetPayloadV1 })
  | (NativeResponseBaseV1 & { operation: "session.disconnect"; ok: true; result: BrowserDisconnectResultV1 })
  | (NativeResponseBaseV1 & { operation: ExtensionOperationV1; ok: false; error: BrowserFailureV1 });

type NativeCapturePermissionArmedV1 = {
  version: 1;
  type: "capture_permission_armed";
  port_nonce: string;
  sequence: 1;                         // first broker capture message after hello
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;               // equals intent.permission_request.request_epoch
  permission_gesture_before: string;
  target: BrowserTargetBindingV1;
  authority_generation: number;        // exact generation containing the committed intent
  capture_intent_committed: true;
  old_data_host_absent: true;
};

type NativeCapturePermissionResultBaseV1 = {
  version: 1;
  type: "capture_permission_result";
  port_nonce: string;
  sequence: 1;                         // first worker message after hello
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  permission_request: Extract<CapturePermissionRequestLifecycleV1, { state: "settled" }>;
};

type NativeCapturePermissionResultV1 = NativeCapturePermissionResultBaseV1 & (
  | { permission_state: "exactly_granted" | "denied_or_partial"; error: null }
  | {
      permission_state: "terminal";
      error: NativeCaptureWorkerErrorV1 & {
        code: "PERMISSION_REQUIRED" | "WRONG_ORIGIN" | "WRONG_ACCOUNT_OR_PLAN" |
          "NOT_LOGGED_IN" | "PROTOCOL_CHANGED" | "SECURITY_CHALLENGE" | "TIMEOUT" |
          "INTERNAL";
      };
    }
);

type NativeCapturePermissionReceiptV1 = {
  version: 1;
  type: "capture_permission_receipt";
  port_nonce: string;
  sequence: 2;                         // armed was broker sequence 1; challenge was not emitted
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  capture_retired: true;
  cleanup_marker_id: string;
  error: NativeCaptureErrorV1;
};

type NativeCaptureObserversReadyV1 = {
  version: 1;
  type: "capture_observers_ready";
  ok: true;
  port_nonce: string;
  sequence: 2;                         // after capture_permission_result
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  target: BrowserTargetBindingV1;
  sentinel_registered_first: true;
  all_nine_listeners_present: true;
  preactivation_eligible_request_seen: false;
  provider_quiescence_proves_no_preexisting_request: true;
  baseline_activity_generation: number; // safe non-negative integer
  credential_quiescence_contract:
    ProviderContractAssetIdentityV1 & { kind: "credential_quiescence" };
  error: null;
};

type NativeCaptureObserversFailureV1 = {
  version: 1;
  type: "capture_observers_ready";
  ok: false;
  port_nonce: string;
  sequence: 2;
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  target: BrowserTargetBindingV1;
  error: NativeCaptureWorkerErrorV1 & {
    code: "PERMISSION_REQUIRED" | "WRONG_ORIGIN" | "WRONG_ACCOUNT_OR_PLAN" |
      "NOT_LOGGED_IN" | "PROTOCOL_CHANGED" | "SECURITY_CHALLENGE" | "INTERNAL";
  };
};

type NativeCaptureObserversResultV1 =
  | NativeCaptureObserversReadyV1 | NativeCaptureObserversFailureV1;

type NativeCapturePrechallengeReceiptV1 = {
  version: 1;
  type: "capture_prechallenge_receipt";
  port_nonce: string;
  sequence: 2;                         // challenge was not emitted
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  capture_retired: true;
  cleanup_marker_id: string;
  error: NativeCaptureErrorV1;
};

type NativeCaptureChallengeV1 = {
  version: 1;
  type: "capture_challenge";
  port_nonce: string;
  sequence: 2;                         // follows capture_observers_ready
  capture_id: string;
  grant_id: string;
  target: BrowserTargetBindingV1;
  worker_instance_id: string;           // exact credential-capture hello value
  listener_epoch: string;               // broker-generated 32-byte base64url hello-ack value
  request_epoch: string;                // exact permission/capture request epoch
  extension_attestation: ConsentGrantV1["extension_attestation"];
  challenge: string;                    // 32 random bytes, unpadded base64url
  accept_before: string;                // min(issue + 60 seconds, authorization expiry)
  expected_account_fingerprint: string;
  expected_budget_fingerprint: string;
  expected_plan_fingerprint: string;
  baseline_activity_generation: number; // exact accepted observers-ready value
  credential_quiescence_contract:
    ProviderContractAssetIdentityV1 & { kind: "credential_quiescence" };
  identity_key: SecretString;            // capture-port memory only; never sent to MAIN world
};

type NativeCaptureSuccessV1 = {
  version: 1;
  type: "capture_outcome";
  ok: true;
  port_nonce: string;
  sequence: 3;                         // follows capture_observers_ready
  capture_id: string;
  grant_id: string;
  challenge: string;
  seed: BrowserCredentialSeedV1;
  seed_jcs_sha256: string;              // lowercase hex SHA-256(JCS(seed))
  seed_auth_tag: string;                // unpadded base64url HMAC over JCS(seed), defined below
  error: null;
};

type NativeCaptureFailureCodeV1 =
  | "PROVIDER_PERMISSION_MISSING" | "CONSENT_EXPIRED" | "QUARANTINED"
  | "PERMISSION_REQUIRED" | "WRONG_ORIGIN"
  | "WRONG_ACCOUNT_OR_PLAN" | "NOT_LOGGED_IN" | "PROTOCOL_CHANGED"
  | "SECURITY_CHALLENGE" | "PROVIDER_UNAVAILABLE" | "PROVIDER_ERROR"
  | "RESPONSE_TOO_LARGE" | "TIMEOUT" | "INTERNAL";

type NativeCaptureWorkerFailureCodeV1 = Exclude<NativeCaptureFailureCodeV1,
  "PROVIDER_PERMISSION_MISSING" | "CONSENT_EXPIRED" | "QUARANTINED">;

type NativeCaptureErrorV1 = {
  code: NativeCaptureFailureCodeV1;
  message: string;                      // exact code-derived literal, <= 512 UTF-8 bytes
  retryable: false;                     // a new foreground gesture is always required
  retry_after_ms: null;
};

type NativeCaptureWorkerErrorV1 = Omit<NativeCaptureErrorV1, "code"> & {
  code: NativeCaptureWorkerFailureCodeV1;
};

type NativeCaptureFailureV1 = {
  version: 1;
  type: "capture_outcome";
  ok: false;
  port_nonce: string;
  sequence: 3;                         // follows capture_observers_ready
  capture_id: string;
  grant_id: string;
  challenge: string;
  seed: null;
  error: NativeCaptureWorkerErrorV1;
};

type NativeCaptureOutcomeV1 = NativeCaptureSuccessV1 | NativeCaptureFailureV1;

type NativeCaptureStageAckV1 = {
  version: 1;
  type: "capture_stage_ack";
  port_nonce: string;
  sequence: 3;
  capture_id: string;
  grant_id: string;
  challenge: string;
  staged_and_validated: true;
  decision_before: string;              // RFC 3339; > ack time, <= challenge accept_before, <= +5s
};

type NativeCaptureDecisionBaseV1 = {
  version: 1;
  type: "capture_decision";
  port_nonce: string;
  sequence: 4;                         // worker's fourth capture message
  capture_id: string;
  grant_id: string;
  challenge: string;
};

type NativeCaptureDecisionV1 = NativeCaptureDecisionBaseV1 & (
  | {
      decision: "commit";
      abort_error_code: null;
      poststage_recheck: CookieSnapshotAssertionV1 & { phase: "poststage_recheck" };
    }
  | {
      decision: "abort";
      abort_error_code: NativeCaptureWorkerFailureCodeV1;
      poststage_recheck: null;
    }
);

type NativeCaptureReceiptBaseV1 = {
  version: 1;
  type: "capture_receipt";
  port_nonce: string;
  capture_id: string;
  grant_id: string;
  challenge: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  capture_retired: true;
  cleanup_marker_id: string;
};

type NativeCaptureReceiptV1 =
  | (NativeCaptureReceiptBaseV1 & {
      receipt_for: "prestage_terminal";
      sequence: 3;                       // next broker message after challenge
      ok: false;
      capture_validated: false;
      session_handle: null;
      error: NativeCaptureErrorV1;
    })
  | (NativeCaptureReceiptBaseV1 & {
      receipt_for: "capture_decision";
      sequence: 4;                       // stage_ack was broker sequence 3
    } & (
      | { ok: true; capture_validated: true; session_handle: null; error: null }
      | {
          ok: false;
          capture_validated: false;
          session_handle: null;
          error: NativeCaptureErrorV1;
        }
    ));

type NativePermissionCleanupChallengeV1 = {
  version: 1;
  type: "permission_cleanup_challenge";
  port_nonce: string;
  sequence: 1;
  marker_id: string;
  challenge: string;                    // 32 random bytes, unpadded base64url
  accept_before: string;                // <= 60 seconds
  extension_id: string;
  profile_instance: string;
  extension_attestation: ConsentGrantV1["extension_attestation"];
  permissions_to_remove: BrowserCleanupMarkerV1["permissions_to_remove"];
  page_observer_to_remove: BrowserCleanupMarkerV1["page_observer_to_remove"];
  browser_realm_to_remove: BrowserCleanupMarkerV1["browser_realm_to_remove"];
  credential_capture_to_remove: BrowserCleanupMarkerV1["credential_capture_to_remove"];
  capture_permission_request: BrowserCleanupMarkerV1["capture_permission_request"];
  provider_logout_to_attempt: BrowserCleanupMarkerV1["provider_logout_to_attempt"];
};

type PageObserverCleanupResultV1 =
  | { status: "not_applicable" }
  | {
      status: "dedicated_ynab_documents_absent";
      cleanup: PageObserverCleanupV1;
      registration_absent: true;
      matching_tabs_absent: true;
    };

type BrowserRealmCleanupResultV1 =
  | { status: "not_applicable" }
  | {
      status: "dedicated_realm_absent";
      cleanup: BrowserRealmCleanupV1;
      registration_absent: true;
      matching_realm_tabs_absent: true;
      target_document_absent: true;
      adapter_closure_absent_by_document_destruction: true;
    };

type CaptureListenerCleanupResultV1 =
  | { status: "not_applicable" }
  | {
      status: "capture_listeners_absent";
      cleanup: CaptureListenerCleanupV1;
      proof:
        | {
            kind: "same_worker_removed";
            worker_instance_id: string;
            has_listener_false_for_all_roles: true;
            epoch_callbacks_quiesced: true;
          }
        | {
            kind: "old_worker_destroyed";
            replacement_worker_instance_id: string;
            old_native_host_absent: true;
            no_persistent_capture_registration: true;
          };
    };

type CapturePermissionRequestCleanupResultV1 =
  | { status: "not_applicable" }
  | {
      status: "settled_and_events_drained";
      request_epoch: string;
      settlement: Extract<CapturePermissionRequestLifecycleV1, { state: "settled" }>["settlement"];
      permission_events_drained: true;
    };

type ProviderLogoutCleanupResultV1 =
  | { status: "not_applicable"; provider_session_revocation: "not_requested" }
  | {
      status: "completed";
      provider_session_revocation: "confirmed" | "not_confirmed";
    }
  | {
      status: "failed";
      provider_session_revocation: "not_confirmed";
      error_code: "PROVIDER_PERMISSION_MISSING" | "SESSION_EXPIRED" |
        "PROVIDER_UNAVAILABLE" | "PROTOCOL_CHANGED" | "TIMEOUT";
    };

type NativeCleanupWorkerErrorV1 =
  | {
      code: "CLEANUP_INCOMPLETE";
      message: "Browser cleanup could not be proven complete.";
      retryable: false;
      retry_after_ms: null;
    }
  | {
      code: "INTERNAL";
      message: "The local browser cleanup component failed.";
      retryable: false;
      retry_after_ms: null;
    };

type NativeCleanupBrokerErrorV1 =
  | {
      code: "CLEANUP_RESULT_INVALID";
      message: "The browser cleanup result did not match the cleanup contract.";
      retryable: false;
      retry_after_ms: null;
    }
  | {
      code: "CLEANUP_TIMEOUT";
      message: "The browser cleanup deadline elapsed.";
      retryable: false;
      retry_after_ms: null;
    }
  | {
      code: "CLEANUP_EXTRA_MESSAGE";
      message: "The browser cleanup channel received an unexpected message.";
      retryable: false;
      retry_after_ms: null;
    };

type NativePermissionCleanupResultV1 = {
  version: 1;
  type: "permission_cleanup_result";
  port_nonce: string;
  sequence: 1;
  marker_id: string;
  challenge: string;
} & (
  | {
      ok: true;
      removed_permissions: BrowserCleanupMarkerV1["permissions_to_remove"];
      page_observer_cleanup: PageObserverCleanupResultV1;
      browser_realm_cleanup: BrowserRealmCleanupResultV1;
      credential_capture_cleanup: CaptureListenerCleanupResultV1;
      capture_permission_request_cleanup: CapturePermissionRequestCleanupResultV1;
      provider_logout: ProviderLogoutCleanupResultV1;
      error: null;
    }
  | {
      ok: false;
      removed_permissions: { permissions: []; origins: [] };
      page_observer_cleanup: null;
      browser_realm_cleanup: null;
      credential_capture_cleanup: null;
      capture_permission_request_cleanup: null;
      provider_logout: null;
      error: NativeCleanupWorkerErrorV1;
    }
);

type NativePermissionCleanupReceiptV1 = {
  version: 1;
  type: "permission_cleanup_receipt";
  port_nonce: string;
  sequence: 2;
  marker_id: string;
} & (
  | { result: "marker_cleared"; marker_cleared: true; pending_obligation: null; error: null }
  | {
      result: "marker_retained_provider_logout";
      marker_cleared: false;
      pending_obligation: "provider_logout";
      error: null;
    }
  | {
      result: "result_rejected";
      marker_cleared: false;
      pending_obligation: null;
      error: NativeCleanupBrokerErrorV1;
    }
);

type NativeMessageV1 =
  | NativeHelloV1 | NativeHelloAckV1 | NativeBindGrantV1 | NativeBindAckV1
  | NativePreparationArmedV1 | NativePreparationTargetReadyV1
  | NativeConnectProbeBeginV1 | NativeConnectProbeOutcomeV1 | NativeConnectProbeReceiptV1
  | NativeGrantActivatedV1 | NativeGrantActivatedAckV1
  | NativeRequestV1 | NativeResponseV1 | NativeStopAndDrainV1 | NativeStopAndDrainAckV1
  | NativeSchedulerRunV1 | NativeDispatchReserveV1 | NativeDispatchDecisionV1
  | NativeDispatchOutcomeV1 | NativeDispatchOutcomeAckV1 | NativeSchedulerRunResultV1
  | NativeCapturePermissionArmedV1 | NativeCapturePermissionResultV1
  | NativeCapturePermissionReceiptV1 | NativeCaptureObserversResultV1
  | NativeCapturePrechallengeReceiptV1
  | NativeCaptureChallengeV1 | NativeCaptureOutcomeV1 | NativeCaptureStageAckV1
  | NativeCaptureDecisionV1 | NativeCaptureReceiptV1
  | NativePermissionCleanupChallengeV1 | NativePermissionCleanupResultV1
  | NativePermissionCleanupReceiptV1;
```

The popup-to-worker gesture channel is also closed; implementers do not invent a generic extension
message relay:

```ts
type PopupCaptureGestureHelloV1 = {
  schema: "nab.popup-capture-gesture-hello/1";
  sequence: 1;                         // popup-to-worker direction
  popup_instance_nonce: string;
};

type PopupCaptureGestureArmedV1 = {
  schema: "nab.popup-capture-gesture/1";
  sequence: 1;                         // worker-to-popup direction
  popup_instance_nonce: string;         // 32 random bytes, unpadded base64url
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  permission_gesture_before: string;
  permissions: ["cookies", "webRequest"];
  origins: ["https://app.ynab.com/*"];
};

type PopupCaptureGestureResultBaseV1 = {
  schema: "nab.popup-capture-gesture-result/1";
  sequence: 2;                         // popup-to-worker direction, after hello
  popup_instance_nonce: string;
  capture_id: string;
  grant_id: string;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
};

type PopupCaptureGestureResultV1 = PopupCaptureGestureResultBaseV1 & (
  | {
      outcome: "not_started_cancelled";
      request_started_before_deadline: false;
      request_started_at_popup_monotonic_ms: null;
      popup_deadline_monotonic_ms: number;
    }
  | {
      outcome: "resolved_true" | "resolved_false" | "rejected";
      request_started_before_deadline: true;
      request_started_at_popup_monotonic_ms: number;
      popup_deadline_monotonic_ms: number;
    }
);
```

`connect.html` opens `chrome.runtime.connect({name:"nab.capture-gesture/1"})`. The worker accepts
exactly one port whose `sender.id` equals the installed extension ID, whose sender URL is exactly
`chrome-extension://<extension-id>/connect.html` with no query/fragment, and whose frame/document
belongs to the current non-incognito dedicated profile. The popup chooses the nonce and sends
exactly one `PopupCaptureGestureHelloV1`; the worker rejects every unknown field, sequence mismatch,
or duplicate/live nonce. Only after validating
`capture_permission_armed`, installing/proving both permission-event listeners, and binding the
durable request epoch does the worker send `PopupCaptureGestureArmedV1`. The popup validates every
tuple member before rendering one single-use button.

On receiving the armed message, the popup converts the remaining UTC interval to its own half-open
monotonic deadline using one wall/`performance.now()` sample; a nonpositive or nonfinite interval
cancels without enabling the button. The button handler atomically disables itself, records the
popup-local monotonic start, and calls `chrome.permissions.request` synchronously
as its first Chrome/IPC/async action; no message, storage call, timer, or awaited work occurs first.
When the promise settles it sends exactly one `PopupCaptureGestureResultV1`, asserting and carrying
`start < popup_deadline`. At an unstarted gesture
deadline it disables the button and sends `not_started_cancelled`. The worker accepts one matching
result, rejects a started branch unless both finite monotonic values satisfy that strict inequality,
combines it with its own permission-event drain and `permissions.contains` checks, and alone
constructs worker-sequence-1 `NativeCapturePermissionResultV1`; the popup never talks to the native
host. Popup close/crash, port loss, duplicate result, or worker replacement before definitive result
leaves durable `may_be_in_flight` and triggers the unresolved-prompt cleanup rules. Neither later
permission events nor a new popup may infer that the original request promise settled.

The service worker calls `connectNative`, sends `hello` first, and requires a valid echoing
`hello_ack` within five seconds. After a successful probe and candidate receipt on that same port,
the broker promotes it by sending exactly one `bind_grant`; the extension validates the complete
broker-supplied mode/profile/version contract but does not treat its own hello fields as package or
profile attestation, retains the reference key only in worker memory, and acknowledges. The bind ack proves only that a candidate/existing record can be loaded;
it grants no data authority. After the authority-index commit the broker sends exactly one
`grant_activated`, requires its echoing ack, and starts broker request sequence at six and worker
response sequence at five. It
rejects requests before activation or outside the
bound mode, plan, capability, schema, age ceiling, and authorization lifetime. At bind it converts
`authorization_expires_at` to a monotonic deadline using the current wall/monotonic pair. It
rechecks both wall and monotonic deadlines immediately before every physical dispatch; either expiry
stops the scheduler, discards all state/keys, and closes the data port. The broker independently
closes the port and begins permission cleanup at the same minimum consent/policy expiry. Clock
rollback fails closed. The host sends at most one request at a time. Both sides require the
same nonce, sequence, request ID, operation, and operation-specific parameter/result schema; a
duplicate, gap, mismatch, unknown field, unexpected direction, oversize frame, or malformed value
closes the port. The nonce is an anti-confusion channel binding, not a substitute for Chrome's
extension-origin enforcement. `bridge.ping` and no-grant status are answered by the local broker;
the only no-grant message that may reach the extension is the cleanup-only subprotocol below. Port close/disconnect zeroes the in-memory grant
context as far as the language permits.

For `credential_capture`, the hello supplies a fresh worker-instance UUID and the broker returns a
fresh 32-byte listener epoch in the purpose-matched hello ack. Fresh managed-runtime attestation
binds the worker/package/profile/target/port before either value is accepted. The extension installs
nothing and requests no optional permission yet. The broker generates the capture ID, precommits the
intent containing that exact worker/epoch and its final-gesture deadline at
`min(now + 5 minutes, authorization_expires_at)`, requiring a positive interval, and only then
closes/proves absent the drained data host and sends the exact
`NativeCapturePermissionArmedV1`. The extension learns the broker-generated capture/grant/deadline
tuple only from that message and shows the final Capture button only after validating its committed
generation, worker, epoch, target, and both literal proof booleans. No challenge deadline starts
during this preflight.

A `permission_cleanup` port is accepted only when the protected authority index contains exactly one
matching cleanup marker and no data bind is active. Its hello has a null target and confers no plan,
identity key, reference key, credential, status, or pending-data authority. The broker requires the
exact extension origin/ID, profile instance, and stored attestation discriminator; managed-attestation
markers require fresh evidence. It sends the marker's closed permission object, observer cleanup
record, realm cleanup record, capture-listener cleanup record, capture-permission lifecycle, logout
obligation, and a single-use 60-second challenge. The capture-listener and capture-permission fields
are null or non-null together. When a logout obligation is present, the extension first executes
only that canonical executable asset and returns its closed result; the action's crash replay is
permitted only because the asset must prove it idempotent. A null obligation requires
`not_applicable`. Only after the logout result is definite does browser cleanup continue. When the
observer field is non-null, the extension performs
section 5.1's exact unregister plus dedicated-profile tab-close/document-absent procedure and returns the
matching closed result; `not_applicable` is valid if and only if the observer marker field is null.
When the realm field is non-null, the extension stops accepting adapter decisions, unregisters the
exact dynamic script ID and proves `getRegisteredContentScripts({ids:[id]})` is empty, then closes every
top-level tab whose current URL matches `https://app.ynab.com/*` in that attested dedicated profile,
proves a repeated `chrome.tabs.query({url:["https://app.ynab.com/*"]})` finds none, and requires
`webNavigation.getFrame` for the saved target to return
null when document-bound. Document destruction is the hard teardown for the MAIN closure; a page
ack is neither required nor trusted. `not_applicable` is valid if and only if the realm marker field
is null. When the capture-listener field is non-null, the extension first establishes the matching
permission-request settlement. A saved `settled` lifecycle must echo exactly. A saved
`may_be_in_flight` lifecycle is accepted only from the same saved worker after its original promise
settles and its `onAdded`/`onRemoved` event queue drains for the same request epoch. A saved
`not_started` lifecycle is accepted only with the broker-owned proof that no armed message was
emitted. The extension then either removes each of the exact six webRequest callback function
references plus the exact cookies callback from the same saved worker instance, requires
`hasListener` false for each, closes the capture Native port/host, and passes the signed quiescence
barrier; or proves that the saved worker instance was destroyed, the
old Native host is absent, and a fresh runtime-attested worker from the same pinned package has no
persistent capture registration. The latter proof is accepted only because the executable capture
contract forbids declarative rules, dynamic content scripts, extension storage, or top-level
registration for capture callbacks; otherwise only whole-profile deletion can satisfy the marker.
The returned cleanup record, listener roles/epoch, and request epoch must echo exactly. For a
`settled` marker, the settlement also echoes byte-for-byte. For a `may_be_in_flight` marker, the
same attested worker may instead report the single monotonic transition to a non-null settlement
for that unchanged request epoch after its event-drain proof; the broker atomically commits that
settled marker projection before it authorizes permission removal or marker clearing.
Ordinary `old_worker_destroyed` is not a settlement proof for a `may_be_in_flight` permission
request; that branch remains blocked unless the whole dedicated Chrome process/profile deletion
proof succeeds. `not_applicable` is valid if
and only if the marker field is null. In the same-worker proof, the result worker ID equals both the
saved capture worker and the cleanup hello. In the destroyed-worker proof, the replacement ID equals
the cleanup hello, differs from the saved worker, and is covered by that port's fresh managed
attestation. It then
calls `chrome.permissions.remove(permissions_to_remove)` using Chrome's native
`{permissions, origins}` shape. It calls `chrome.permissions.contains` separately for every
singleton `{permissions:[p]}` and `{origins:[o]}` and requires every result to be false before
returning the exact same structured object. It then drains all permission events through a new
generation, removes the exact two permission-event callbacks, and requires `hasListener` false for
both. Only then may it return
`capture_permission_request_cleanup.status="settled_and_events_drained"`. The broker validates all echoed observer/realm/capture/
permission/logout result fields and consumes the challenge on success or failure. It atomically
clears the sole marker only when every non-null browser cleanup has its exact completed proof, every
named permission/origin is definitely absent, the permission request is definitively settled and
its event listeners quiesced/absent, and logout is either not applicable or completed.
`capture_permission_request_cleanup.status="not_applicable"` is valid if and only if the marker's
capture-permission lifecycle is null. A valid result in which browser cleanup completed but provider
logout failed retains the entire marker
for idempotent trusted retry and receives `marker_retained_provider_logout`; no successful browser
step is falsely downgraded in the disconnect report. Failure, timeout, object/result mismatch, or an
extra message receives `result_rejected` and leaves the marker intact. Port loss produces no wire
receipt; the broker consumes/records the fixed local cleanup failure, retains the marker, and
surfaces it only through authenticated local status/trusted UI. A trusted user may
later explicitly abandon an unconfirmed logout after the UI explains that profile deletion/local
cleanup does not revoke the server session; that authority transaction sets only
`provider_logout_to_attempt=null`, returns `provider_session_revocation=not_confirmed` in that
trusted cleanup result, and still requires every browser obligation/profile deletion proof before
clearing the marker. No cleanup port can be promoted to a data/connect/capture port, and a matching
marker must be resolved before any later grant bind.

Cleanup error mapping is exact. A worker uses `CLEANUP_INCOMPLETE` only when a named browser
postcondition is false or cannot be proven, and `INTERNAL` only for a local extension/API failure;
the literal type-defined message/retry fields are recomputed by the broker. A syntactically or
semantically mismatched result maps to `CLEANUP_RESULT_INVALID`, an elapsed cleanup challenge to
`CLEANUP_TIMEOUT`, and a duplicate/out-of-order/extra frame to `CLEANUP_EXTRA_MESSAGE`. No other
code or message is legal and no browser/provider text crosses the channel. The last three produce a
receipt only while the port is still writable; port loss follows the no-receipt rule above.

Scheduler control is a separate closed subprotocol multiplexed on the bound data port. Broker and
worker each maintain an independent safe-integer `control_sequence` starting at one; every sender
increments its own value and every receiver rejects a duplicate/gap. Control messages may interleave
with memory-only CLI request/response frames but only one scheduler run and one dispatch reservation
may be active. The broker emits `scheduler_run` only from its cadence timer, never because a pending
call arrived. Before emitting a run, the broker holds one application-installation scheduler mutex,
requires rolling-hour capacity for the signed maximum whole burst, atomically appends that many
timestamp slots, and sends their random `burst_reservation_id` plus count. It holds the mutex through
the final run result. Unused family/failed-run slots are never released and count conservatively;
therefore every physical dispatch is accounted and a second profile cannot exhaust capacity midway.
If the whole burst does not fit, no run message is sent and the broker schedules eligibility when
enough oldest slots expire.

Every `run_id`, `burst_reservation_id`, `logical_request_id`, and per-permit `reservation_id` is a
canonical lowercase UUIDv4 generated by the component that first emits it, unique for the complete
port lifetime and never reused after failure. Each later message must echo the exact tuple established
by its parent run/reserve/permit; a field from another live or completed tuple closes the port. Run
and reservation IDs are forbidden from logs and durable rate state except for
`burst_reservation_id`/`run_id` in the closed records already specified.

Before each physical request, the worker performs every local outbound guard and sends
`dispatch_reserve`. The broker rechecks grant/policy expiry, exact burst reservation, run
kind/ordinal/ceiling, and provider delay; it consumes one pre-counted slot before returning one
permit valid for at most five seconds. Initialization accepts only
these sequences: `getInitialUserData/null`, `syncCatalogData/null`, optional
`syncFamilyData/null`, `syncBudgetData/bootstrap`, `syncBudgetData/backfill`. Refresh accepts only
`syncCatalogData/null`, optional `syncFamilyData/null`, `syncBudgetData/delta`. Ordinals start at one
and are contiguous; any other operation/sync-type/order/burst is a protocol violation that closes
the port and destroys the device. A reserved slot remains consumed even if the worker subsequently
proves it did not dispatch, preventing crash/reconnect bypass.

If an otherwise valid reservation is blocked, the broker returns the exact echoing deny variant.
`RATE_LIMITED` has the full valid remaining delay and retains a not-in-flight device;
consent/provider-policy expiry has null delay and destroys it. The worker ends the run without
dispatch and reports the same terminal result. Unknown deny codes, inconsistent disposition, or a
non-null/clamped invalid delay are protocol violations. Invalid ordinals are not turned into a
helpful denial oracle.

The worker uses a permit once, only for the exact request/operation, and reports one closed outcome;
it may report `permit_expired_unused` only when it proves no dispatch. The broker persists any valid
Retry-After/result class before acking. Loss after permit but before a definitive outcome is
bootstrap `SESSION_STATE_UNKNOWN` or other `READ_RESULT_UNKNOWN`, counts against the rate window,
and destroys the logical device. A lost outcome ack is not permission to redispatch. The final run
result arrives only after every reserved operation has an ack and all entity/cursor commits are
complete. Unknown messages, ordinals, reservations, or timeouts close the port and fail closed.

On a `connect_probe` port, the hello must name the user-selected pre-mutation top-level tab and
document. That hello-only port has no browser-data or mutation authority. After host/profile/
attestation validation, the broker commits `browser_preparation:not_started`, commits
`may_have_occurred`, and sends exactly one `NativePreparationArmedV1`; the extension MUST NOT request
permission, register a script, reload, create a realm, or read private page identity before that
message. Port loss before `preparation_armed` clears a `not_started` intent; loss afterward converts
the intent to cleanup. Within 60 seconds the worker returns exactly one
`NativePreparationTargetReadyV1`. Page-snapshot requires the same tab ID, a new top-level document
ID, non-null bounded page-instance ID, observer scope non-null, and realm fields null.
Browser-catalog requires observer/page-instance null, its saved realm scope non-null, the same
adapter instance ID, the policy URL, and a new exact top-level realm document. Native-replay requires
both scope fields and both instance fields null and its prepared exact target. These mode matrices
are biconditional. The broker revalidates the target/profile/build boundary, atomically changes the
intent to document-bound where applicable, and only then sends one
begin message with a 60-second single-use challenge and candidate identity key. The service worker
reads the fixed bounded identity projection, computes fingerprints locally, erases raw IDs, and
returns exactly one success/failure outcome. Failure contains only the closed code and code-derived
literal; page labels/provider text never cross. The broker validates the echo and atomically consumes
the challenge for either branch. It maps failure to the same broker error and returns a failure
receipt without disclosure/grant. On success it validates Unicode display labels as specified below
before showing disclosure. After trusted approval/candidate commit it returns the candidate-only receipt;
cancellation/error returns a failure receipt. The
probe phase then ends but the port remains open and receives the candidate `NativeBindGrantV1`;
the reference key is never sent before that promotion. The foreground connect
ceremony remains pending until candidate bind, activation commit, and activation ack complete.

On the data port the extension returns only browser-normalized result types with public IDs null and
public capabilities false. The broker revalidates the observed binding, composes `plan_ref`, consent,
provider-policy, and warning from protected state,
then authenticates/flushes the CLI response. The proxy host never reads the CLI pairing key. No raw
page object or provider credential crosses the data port.

Version 1 composes no public-join field: both public IDs and both capabilities remain fixed null/false.
A provider-defined join requires a new normalized schema/profile version, not an extra field on this
port.

The credential-capture port is a separate developer-only exception. After the same hello/host
checks, it is accepted only for an active `native-replay` grant whose fresh provider-managed runtime
attestation binds this exact target/profile/port; a self-reported profile instance is insufficient.
After preflight and the durable request-epoch intent transition, the broker sends broker-sequence-1
`capture_permission_armed`. The extension installs/proves its two permission observers before
showing the final button; the click changes only in-memory state and synchronously invokes
`chrome.permissions.request` before awaiting work. Worker-sequence-1 `capture_permission_result`
echoes the worker/listener/request/capture/grant tuple and a definitively settled, event-drained
lifecycle. The broker commits that lifecycle first. A denied, partial, or terminal result is then a
terminal branch: the broker atomically performs `capture_completion_retirement`, and only afterward
may it emit broker-sequence-2 `capture_permission_receipt` containing the committed marker ID.

An exact grant does not start the challenge. The extension installs the all-tabs sentinel first,
then all remaining catalog/cookie observers, runs the signed bootstrap/in-flight/quiescence barrier,
and emits worker-sequence-2 `capture_observers_ready`. A failure is terminal and receives
`capture_prechallenge_receipt` only after the same retirement commit. For success, the broker saves
the complete accepted ready record, rechecks boot/wall/monotonic clocks, consent, provider policy,
attestation, and binding, and sends broker-sequence-2 `capture_challenge` only if all are still valid.
The challenge carries the accepted request epoch, baseline activity generation, and quiescence
asset. Thus transient user activation never crosses a Native round trip and no challenge clock runs
while the user is deciding or while observers arm.

Worker-sequence-3 `capture_outcome` must echo the complete challenge tuple and arrive before the
half-open deadline. A worker may emit only `NativeCaptureWorkerFailureCodeV1`; before accepting any
worker message, the broker applies the authoritative priority `QUARANTINED`, then
`CONSENT_EXPIRED`, then `PROVIDER_PERMISSION_MISSING`. Those causes come only from broker clocks and
validated policy/assets and may replace a worker-observable cause. A worker `TIMEOUT` is upgraded to
`CONSENT_EXPIRED` only when the broker's authorization interval actually ended. A failure or seed-
validation failure consumes the challenge, erases all secret state, commits capture retirement, and
then may emit broker-sequence-3 `prestage_terminal` with the committed marker ID.

A valid success atomically becomes `NativeStagedCaptureV1` and receives broker-sequence-3
`capture_stage_ack`; the helper cannot use, persist, or expose the seed. Its `decision_before` is the
earlier of challenge `accept_before` and five seconds after the validator sample, with matching wall,
monotonic, and boot checks. The extension sends worker-sequence-4 commit/abort while all observers
remain armed. Commit carries the exact authenticated post-stage snapshot assertion; abort carries
one worker-owned code and null assertion. The broker applies its authoritative cause priority again,
validates a commit against the staged record, consumes the challenge, erases the complete staged
record, atomically commits capture retirement, and only then may emit broker-sequence-4
`capture_decision` receipt with the marker ID. `ok=true` requires a consumed valid commit,
`capture_validated=true`, and `error=null`; every other branch is false with a fixed error.

Timeout, duplicate, mismatch, extra message, or unexplained close never means success. If the port
still exists, a timeout/error receipt is sent only after retirement; port/process loss yields no
receipt and startup/terminal handling projects the marker from the durable intent. No staged seed
has a crash-recovery representation. Every terminal receipt therefore proves authority retirement;
the worker never performs a second retirement after receiving it. Version 1 success means only that
the helper validated and erased the seed. It creates no handle or credential authority, has no
Castle/request-material message, and remains disabled by section 9.2.

Browser failures never set broker-owned auth/consent/policy state directly. The broker validates and
discards all page/provider-supplied text, regenerates the fixed message from the validated code, and
overwrites retry metadata using section 7.4. The service worker likewise overwrites projection
`observed_at` with its own wall clock at successful extraction completion; record timestamps derive
only from that value. The broker maps `DISPATCH_OUTCOME_UNKNOWN` to
`READ_RESULT_UNKNOWN`, `SESSION_ROTATION_UNKNOWN` to `SESSION_STATE_UNKNOWN`, and
`WRITE_GUARD_VIOLATION` to `AMBIGUOUS_COMMIT`, then discards the logical device. Those retained
broker states explain why `BrowserStatusProbeV1` does not expose the three ambiguity values.

Content scripts cannot connect directly to the native host. MAIN-world code returns a value to the
service worker through `chrome.scripting.executeScript`; it never receives a pairing key or native
command.

## 9. Cookie-capture mode

### 9.1 What a usable session actually contains

A static `Cookie` header is not a session. Separate four objects:

```ts
type CookieSnapshotAssertionV1 = {
  phase: "post_rotation" | "prestage_recheck" | "poststage_recheck";
  exact_url: string;
  store_id: string;
  selected_partition_key: Exclude<CookieRecordV1["partition_key"], null>;
  unpartitioned_query_count: 1;
  selected_partition_query_count: 1;
  unpartitioned_result_count: number;
  selected_partition_result_count: number;
  unpartitioned_array_auth_tag: string; // phase-bound HMAC defined below
  selected_partition_array_auth_tag: string;
  activity_generation_before: number;  // safe non-negative integer
  activity_generation_after: number;   // exactly equal to before
};

type CaptureBrowserEvidenceV1 = {
  schema: "nab.capture-browser-evidence/1";
  worker_instance_id: string;           // UUIDv4; equals the precommitted listener cleanup target
  listener_epoch: string;               // equals the precommitted 32-byte base64url epoch
  request_epoch: string;                // equals the intent and accepted observers-ready record
  runtime_attestation_evidence_sha256: string;
  observed_operation: "syncCatalogData" | "syncFamilyData" | "syncBudgetData";
  request_assertion: {
    exact_url: string;                  // equals mode_contract.exact_catalog_url
    method: "POST";
    initiator: "https://app.ynab.com";
    top_level_selected_document: true;
    correlation_fingerprint: string;    // HMAC below; never the client request ID
  };
  passive_success_contract: ProviderContractAssetIdentityV1 & { kind: "passive_success_signal" };
  passive_success_payload_schema: ProviderContractAssetIdentityV1 & { kind: "wire_json_schema" };
  cookie_rotation_contract: ProviderContractAssetIdentityV1 & { kind: "cookie_rotation" };
  credential_quiescence_contract:
    ProviderContractAssetIdentityV1 & { kind: "credential_quiescence" };
  application_success: true;
  session_rotation_complete: true;
  cookie_rotation_complete: true;
  cookie_snapshots: [
    CookieSnapshotAssertionV1 & { phase: "post_rotation" },
    CookieSnapshotAssertionV1 & { phase: "prestage_recheck" }
  ];
  session_token_capture_semantics:
    "eligible_request_header_remains_current" | "post_success_accessor";
  evidence_auth_tag: string;             // unpadded base64url HMAC-SHA-256
};

type BrowserCredentialSeedV1 = {
  version: 1;
  exact_origin: "https://app.ynab.com";
  grant_id: string;
  capture_challenge: string;            // outstanding 32-byte base64url native challenge
  captured_at: string;
  accept_before: string;                // exact outstanding challenge UTC deadline
  observed_operation: "syncCatalogData" | "syncFamilyData" | "syncBudgetData";
  profile_instance: string;
  target: BrowserTargetBindingV1;
  cookie_store_id: string;
  selected_partition_key: Exclude<CookieRecordV1["partition_key"], null>;
  observed_account_fingerprint: string;
  observed_budget_fingerprint: string;
  observed_plan_fingerprint: string;
  unpartitioned_cookies: CookieRecordV1[];
  selected_partition_cookies: CookieRecordV1[];
  session_token: SecretString;
  session_token_provenance: "eligible_request_header_remains_current" | "post_success_accessor";
  api_version: string;
  app_version: string | null;
  browser_evidence: CaptureBrowserEvidenceV1;
};

type CookieRecordV1 = {
  name: string;
  value: SecretString;
  domain: string;
  path: string;
  secure: boolean;
  http_only: boolean;
  host_only: boolean;
  session: boolean;
  same_site: "no_restriction" | "lax" | "strict" | "unspecified";
  expiration_date: number | null;
  store_id: string;
  partition_key: {
    top_level_site: string;
    has_cross_site_ancestor: boolean;
  } | null;
};

type NativeLogicalDeviceV1 = {
  device_id: SecretString;             // newly generated UUIDv4, not copied browser ID
  device_info: DeviceInfo;             // same new ID plus truthful, provider-approved native values
  catalog_knowledge: KnowledgeStateV1;
  family_knowledge: KnowledgeStateV1 | null;
  budget_knowledge_by_version: Record<string, KnowledgeStateV1>;
};

type PerRequestSecurityMaterial = {
  castle_request_token: SecretString;
  client_request_id: string;
};

type NativeStagedCaptureV1 = {
  canonical_seed_jcs: SecretString;     // bounded memory-only UTF-8 bytes, never serialized again
  seed_jcs_sha256: string;
  identity_key: SecretString;
  capture_id: string;
  grant_id: string;
  challenge: string;
  target: BrowserTargetBindingV1;
  worker_instance_id: string;
  listener_epoch: string;
  request_epoch: string;
  baseline_activity_generation: number;
  credential_quiescence_contract:
    ProviderContractAssetIdentityV1 & { kind: "credential_quiescence" };
  exact_catalog_url: string;
  cookie_store_id: string;
  selected_partition_key: Exclude<CookieRecordV1["partition_key"], null>;
  unpartitioned_result_count: number;
  selected_partition_result_count: number;
  accept_before_utc: string;
  accept_before_monotonic_ms: number;
  stage_sample_utc: string;
  stage_sample_monotonic_ms: number;
  decision_before_utc: string;          // min(accept_before_utc, stage sample + 5s)
  decision_before_monotonic_ms: number; // same duration-derived half-open deadline
  boot_id: string;
};
```

The native helper accepts a seed only by the following closed
`validateBrowserCredentialSeedV1(outcome, outstanding, hello, binding, policy)` algorithm. The
broker's `outstanding` record contains the exact challenge message plus `issued_at_utc`,
`issued_at_monotonic_ms`, `accept_before_monotonic_ms`, and `boot_id`; the two deadlines are derived
from the same duration and the Native message's `accept_before` is its exact UTC deadline.

1. Run the duplicate-key-aware lexical parser and the closed seed/cookie schema before copying any
   secret string. Reject unknown/missing fields, invalid Unicode/numbers/times, noncanonical UUID/
   base64url values, and every per-field/count/JCS/frame bound below.
2. Require exactly one live, unused outstanding record and byte equality of
   `outcome.port_nonce/capture_id/challenge/grant context` with it. Require
   `seed.grant_id === outstanding.grant_id` and
   `seed.capture_challenge === outcome.challenge === outstanding.challenge`.
3. Require `hello` to be the already verified credential-capture hello on that port. Require
   `seed.profile_instance` and `seed.target` to equal both the active binding and outstanding
   challenge byte-for-byte. Separately require the port/hello/outstanding extension identity,
   loaded-package/runtime attestation, and dedicated-profile/process identity to equal the active
   protected binding. Those values are deliberately absent from the seed, and self-reported hello
   identity never substitutes for the managed attestation.
4. Require all three seed fingerprints to equal both their corresponding outstanding expected
   fingerprints and the active protected binding. Fingerprint recomputation happened in the
   service worker with the challenged `identity_key`; the native helper compares only the resulting
   fixed-length values in constant time.
5. Require `seed.accept_before === outstanding.accept_before`. Sample wall time, monotonic time,
   and boot ID on receipt; boot ID must be unchanged, monotonic time must lie in
   `[issued_at_monotonic_ms, accept_before_monotonic_ms)`, wall time must not precede
   `issued_at_utc` and must be strictly earlier than `accept_before`, and the global
   clock-quarantine rules must be clear. The accepted policy/consent authorization interval must
   still be open on both clocks and `accept_before` must equal the earlier of its saved end and
   exactly 60 seconds after challenge issue; expiry or clock quarantine selects capture retirement,
   never seed acceptance.
   `captured_at` must be canonical RFC 3339 UTC and lie between `issued_at_utc` and the receipt wall
   sample inclusive, but it is audit metadata and never extends either authoritative deadline.
6. Strictly validate `browser_evidence`, require its HMAC as defined below, and require its
   worker/listener/request-epoch/runtime-attestation values to equal the intent, accepted
   observers-ready record, challenge, hello, active binding, and policy. Resolve every asset
   identity by exact ID/kind/schema/hash, including exact equality of the evidence and challenge
   quiescence asset. Require
   `observed_operation === browser_evidence.observed_operation` and require that value to be one
   post-bootstrap operation permitted by the native mode contract (`syncCatalogData`,
   `syncFamilyData`, or `syncBudgetData`). `getInitialUserData` is never accepted. Require literal
   true for all three completion assertions. Require the exact two-element cookie-snapshot tuple,
   its phase literals/order, and equal before/after and cross-phase activity generations. Every
   such generation must equal the challenge's broker-accepted `baseline_activity_generation`; a
   later quiet epoch after intervening activity is not accepted.
7. Require `exact_origin`, target origin, every snapshot/evidence URL, request method/initiator assertion,
   and selected non-incognito tab/document to equal the native mode contract and protected target.
   Require `cookie_store_id` and every snapshot store ID to be the one store selected for that target
   epoch. Require one non-null `selected_partition_key` equal to every snapshot key. For both
   evidence snapshots, require exactly one query of each named kind, exact result counts equal to
   the two seed-array lengths, and valid phase-bound array HMACs over those exact arrays. Every
   unpartitioned-array cookie has null partition; every selected-partition-array cookie has a
   partition byte-equal to the selected key; every cookie's `store_id` equals the selected store.
   No other store/partition is accepted. The arrays remain separate even when either is empty, so
   an empty query result is distinguishable from a query that never occurred.
8. Require `api_version === mode_contract.api_version_header.value`. Under
   `observed_web_app_version_header.required_literal`, `app_version` equals its literal; under
   `omitted`, it is null. Require `session_token_provenance` to select exactly the corresponding
   signed `session_token_capture` branch and evidence semantic, and require the token to be the
   value produced by that branch after the correlated passive success signal. No pre-success
   fallback is accepted.
9. Apply every cookie uniqueness/prefix/session/expiry/domain/path/Secure/SameSite/partition rule
   and every size bound below. Serialize the accepted parsed `seed` with strict JCS into a new
   bounded native buffer. Require lowercase-hex
   `seed_jcs_sha256 === SHA-256(JCS(seed))`, then require `seed_auth_tag` to equal the HMAC defined
   below in constant time. The helper does not claim to possess, or compare against, the worker's
   original serialization buffer: Chrome Native Messaging carried a JSON object, so the native
   JCS serialization and these explicit commitments are the complete wire-verifiable contract.
   Reject Castle material, browser device IDs, client request IDs, raw request bodies, headers, or
   any extra credential/security field anywhere in the aggregate.
10. On success, atomically transform the outstanding record into exactly one bounded memory-only
    `NativeStagedCaptureV1`: move the native canonical buffer and retain only the listed identity
    key, challenge/observer/binding metadata, counts, and clock deadline needed to authenticate a
    decision. At that same stage sample derive/save both exact decision deadlines and require the
    `capture_stage_ack.decision_before` to equal `decision_before_utc`. Every decision validation
    resamples the unchanged boot/wall/monotonic clocks and requires both to lie in the staged half-
    open interval; the challenge deadline is never reconstructed after the outstanding record is
    consumed. Consume every other prestage reference and emit one `capture_stage_ack`. On commit,
    validate every `poststage_recheck` field against that staged record: literal phase; exact URL,
    store, partition key, query-count literals; result counts; baseline-equal generations; canonical
    tag lengths; and both phase-bound array HMAC values recomputed from the staged seed arrays. On
    any failure, abort decision, timeout, port loss, or process exit, erase the entire staged record
    including the identity key and canonical seed. No stage survives restart. On prestage failure,
    erase all reachable seed/
    parsed/cookie/token buffers, consume the challenge, and emit the broker-sequence-3 fixed failure
    receipt. No partial seed survives validation.

Every equality above is exact decoded-byte/string equality with no Unicode normalization.
`browser_evidence.evidence_auth_tag` is
`base64url(HMAC-SHA-256(identity_key, UTF8("nab-capture-browser-evidence-v1\0") ||
UTF8(JCS(browser_evidence without evidence_auth_tag))))`. Its
`request_assertion.correlation_fingerprint` is
`base64url(HMAC-SHA-256(identity_key, UTF8("nab-capture-request-correlation-v1\0") ||
UTF8(client_request_id)))`; the raw client request ID is erased after building the evidence. The
two cookie-array tags in each snapshot are respectively
`base64url(HMAC-SHA-256(identity_key, UTF8("nab-cookie-snapshot-v1\0") || UTF8(phase) ||
0x00 || UTF8("unpartitioned") || 0x00 || UTF8(JCS(unpartitioned_cookies))))` and the same
preimage with `selected_partition` and `JCS(selected_partition_cookies)`. Each tag is exactly 43
unpadded base64url characters. The post-stage assertion uses the same formulas with
`phase="poststage_recheck"`; it travels only in the commit decision and is not part of the frozen
seed. Counts and tags from all three phases must match the staged arrays, and all six activity-
generation values must be equal. Thus each phase performs exactly one query of each kind while the
wire contract still represents all three snapshot rounds without exposing an offline-guessable
bare digest of cookie values. The
managed extension constructs the evidence only after correlating the passive application signal,
request callbacks, cookie rotations, and query results. The native helper can verify its schema,
binding, assets, counts, and HMAC, but cannot independently observe those browser events; therefore
the evidence is an attested extension assertion, not a server proof. These rules are in addition
to—never a substitute for—the provider-managed extension/capture contract and running-package
attestation. Missing either keeps capture disabled.

For the complete seed, the worker computes both commitments over the same strict-JCS byte string:
`seed_jcs_sha256 = lowercaseHex(SHA-256(UTF8(JCS(seed))))` and
`seed_auth_tag = base64url(HMAC-SHA-256(identity_key,
UTF8("nab-capture-seed-v1\0") || UTF8(JCS(seed))))`. The worker sends the typed `seed` object and
those two commitments, not an opaque byte buffer. The native helper first applies the closed parser
and bounds, independently JCS-serializes the parsed object once, and verifies both commitments
before staging. `seed_jcs_sha256` is exactly 64 lowercase hexadecimal characters and
`seed_auth_tag` is exactly 43 unpadded base64url characters. The worker erases its JCS buffer and
all seed references after terminal receipt or terminal timeout; the native helper erases its
independent canonical buffer under the stage/decision rules.

`BrowserStatusProbeV1.source` must equal the bound non-native mode and `target` must equal the
protected target byte-for-byte. A target/source/fingerprint binding mismatch is a closed
`BrowserFailureV1`, never a status value. Status mapping is exact:

| `page_state` | broker state | pending-operation error |
| --- | --- | --- |
| `no_tab` | `browser_unavailable` | `NO_YNAB_TAB` |
| `wrong_origin` | `page_not_ready` | `WRONG_ORIGIN` |
| `not_logged_in` | `reauth_required` | `NOT_LOGGED_IN` |
| `reauth_required` | `reauth_required` | `SESSION_EXPIRED` |
| `not_ready` | `page_not_ready` | `PAGE_NOT_READY` |
| `reload_required` | `page_not_ready` | `PAGE_RELOAD_REQUIRED` |
| `completeness_unproven` | `page_not_ready` | `PAGE_COMPLETENESS_UNPROVEN` |
| `unsaved_changes` | `page_not_ready` | `PAGE_UNSAVED_CHANGES` |
| `sync_in_progress` | `sync_in_progress` | `PAGE_SYNC_IN_PROGRESS` |
| `initializing` | `initializing` | `PAGE_NOT_READY` |
| `partial_backfill` | `partial_backfill` | `PARTIAL_BACKFILL` |
| `ready` | `ready` | none |
| `stale` | `stale` | `STALE_DATA` |
| `permission_denied` | `permission_denied` | `PERMISSION_DENIED` |
| `protocol_changed` | `protocol_update` | `PROTOCOL_CHANGED` |
| `schema_changed` | `protocol_update` | `SCHEMA_CHANGED` |
| `security_challenge` | `security_challenge` | `SECURITY_CHALLENGE` |
| `quarantined` | `quarantined` | `QUARANTINED` |

Only `ready`/`stale` carry identities and age. Every other branch carries literal nulls, so a
partially initialized or failing page cannot smuggle an identity assertion into status.

`accept_before` governs only acceptance of the seed by the helper; it is not provider-session
expiry. Provider credential validity remains unknown and individual persistent-cookie expiry values
do not establish session-token/Castle validity.

Across the concatenation of `unpartitioned_cookies` followed by
`selected_partition_cookies`, cookie records are unique by
`(store_id, partition_key, domain, path, name)`. Each array is deterministically ordered by that
tuple. Strings compare by raw UTF-8 bytes. A null partition sorts before a non-null
partition; non-null partitions compare `(top_level_site UTF-8 bytes,
has_cross_site_ancestor false-before-true)`. `expiration_date` is null or a finite, non-negative
RFC-8785/binary64 Unix-seconds value; negative zero is rejected and
`session === (expiration_date === null)` in both directions.

Cookie applicability uses the closed `nab.chrome-cookie-accept/1` algorithm, not an ambient
interpretation of RFC 6265:

1. The request host/path are literal `app.ynab.com` and `/api/v1/catalog`. A host-only cookie has
   `domain === "app.ynab.com"`. A non-host-only cookie has domain exactly `.app.ynab.com`.
   Domain is lowercase ASCII, has no trailing dot, and no other value is accepted. In particular,
   `.ynab.com` is rejected because the exact `https://app.ynab.com/*` host permission cannot prove
   Chrome returned every applicable parent-domain cookie.
2. `name` is nonempty ASCII `0x21..0x7e` excluding the separator bytes
   `()<>@,;:\"/[]?={} ` and backslash. `value` is empty or consists only of ASCII `0x21`,
   `0x23..0x2b`, `0x2d..0x3a`, `0x3c..0x5b`, or `0x5d..0x7e`. This fail-closed profile does not
   decode percent escapes or quoted values.
3. `path` begins `/` and every following byte is ASCII `0x20..0x3a` or `0x3c..0x7e` (semicolon and
   controls are excluded). It path-matches only if it equals the request path, or is a prefix and
   either ends `/` or the next request-path byte is `/`.
4. Every accepted cookie requires `secure === true`; there is no non-Secure branch. Chrome checks a
   cookie-domain URL derived from the cookie's Secure bit against extension host permission, so the
   HTTPS-only permission cannot prove completeness for an applicable non-Secure cookie.
   `__Secure-` requires Secure. `__Host-` requires Secure, host-only exact domain,
   and path `/`; `__Http-` additionally requires HttpOnly, and `__Host-Http-` requires all host and
   HttpOnly rules. Prefix tests are case-sensitive.
5. A partition `top_level_site` is exactly `https://` plus a lowercase ASCII DNS name: dot-separated
   1..63-byte labels of alphanumeric/hyphen, each beginning and ending alphanumeric, total host at
   most 253 bytes, with no port, slash, userinfo, query, fragment, trailing dot, or percent escape.
   The explicit cross-site boolean is preserved. No registrable-domain equivalence is inferred.
6. Every record matches the selected store and satisfies `partition_key === null ||
   partition_key === selected_partition_key`; all expiration, array-origin, ordering, uniqueness,
   and size rules in this section are then applied. Any failure rejects the complete seed.

Chrome's cookie API does not expose enough request-cookie
creation/order metadata to prove byte-identical native reproduction, so ordering/replay remains a
provider-contract blocker even if these records validate.
The provider contract must additionally assert that every credential cookie required for the
catalog request is Secure and scoped no wider than `app.ynab.com`/`.app.ynab.com`; otherwise capture
aborts as `PROVIDER_PERMISSION_MISSING`. This is required because Chromium filters cookie API
results by a cookie-domain URL and extension host permission, as implemented in
[`cookies_helpers.cc`](https://chromium.googlesource.com/chromium/src/+/faf0601ad0d8dc5cbf5b94d07e3b43debc512a5b/chrome/browser/extensions/api/cookies/cookies_helpers.cc)
and its
[`cookies_helpers.h`](https://chromium.googlesource.com/chromium/src/+/faf0601ad0d8dc5cbf5b94d07e3b43debc512a5b/chrome/browser/extensions/api/cookies/cookies_helpers.h).
NAB does not silently broaden consent to HTTP or all of `ynab.com`.
The referenced executable `required_cookie_scope` asset has schema
`nab.required-cookie-scope/1` and fixed literals
`request_host="app.ynab.com"`, `request_path="/api/v1/catalog"`,
`extension_origins=["https://app.ynab.com/*"]`,
`all_catalog_credential_cookies_secure=true`, and
`all_catalog_credential_cookie_domains=["app.ynab.com",".app.ynab.com"]`. It also carries a
duplicate-free raw-UTF-8-sorted `required_cookie_keys` array of exact
`{name,domain,host_only,path,partition:"unpartitioned"|"selected_partition"}` records. Capture
requires every named key exactly once in its designated array and rejects contradictory extras;
the provider assertion that no required key exists outside this representable scope is part of the
written/executable contract. The current policy has no such executable asset, so this remains a
hard gate rather than an inferred cookie list.

The extension refuses capture below Chrome 132 or the policy's pinned minimum version, whichever is
later. An absent
`partitionKey` property maps to `null`. A non-null value must contain a valid HTTPS serialized
Chrome schemeful `topLevelSite` and an explicit boolean
`hasCrossSiteAncestor`; if the running Chrome version omits either required member, capture aborts
rather than guessing a default. The bridge preserves it byte-for-byte and never derives it from, or
equates it to, the document origin.

Closed capture bounds are: at most 256 cookie records across both arrays; name 1..256 ASCII bytes; value 0..8,192 ASCII bytes;
domain 1..253 ASCII bytes; path 1..4,096 ASCII bytes; store ID 1..256 UTF-8 bytes; top-level site
1..2,048 ASCII bytes; session token 1..16,384 ASCII bytes; API/app version 1..256 ASCII bytes when
present; and complete `BrowserCredentialSeedV1` JCS at most 921,600 UTF-8 bytes. Session/API/app
values must additionally satisfy `nab.http-field-value/1` before copying. All strings are
Unicode scalar sequences with no implicit normalization; field and aggregate limits are checked
before copying into the Native message. The complete `NativeCaptureOutcomeV1` still must fit the
1,048,576-byte Chrome body limit.

`device_info.id` MUST equal `device_id`. Native software MUST NOT copy or claim Chrome/browser/OS
identity strings; provider-approved fields describe the actual native integration and omitted
optional fields stay omitted.

The Castle token is generated for each current web request by `Castle.createRequestToken()`. A token
captured from one request is not specified as reusable or durable. `native-replay` is therefore not
actually independent/headless unless YNAB supplies an authorized native anti-abuse contract. Asking
Chrome for a fresh token per request makes Chrome part of the transport and removes most of the
claimed benefit of raw export.

The native client MUST generate its own logical device and cursor state. It MUST NOT use the
official tab's device ID while maintaining different knowledge counters.

### 9.2 Current availability gate

Cookie capture is a research artifact only in this specification. A native helper MUST NOT send any
request to YNAB with a captured seed under the currently verified evidence. Satisfying the following
provider facts is necessary but not sufficient for dispatch: a written provider contract must define
all of: permitted endpoints and operations,
session/cookie rotation, an authorized way for the native client to obtain a fresh Castle token (or
an explicit exemption), truthful native device registration/header values, required Origin/Referer
and `X-Requested-With` semantics, TLS expectations, rate limits, retry/idempotency rules, and server-
side revocation. Captured Castle material is never reused, synthesized, or requested through a
generic browser token-minting bridge. Version 1 can never dispatch even when all of those facts are
supplied: `NativeBindGrantV1.execution` is permanently `capture_only_dispatch_disabled`, and no
helper HTTP/rotation/Castle message or durable state exists. Actual replay requires
`nab-ynab-bridge/2` (or later) to specify and test that complete transport/state protocol. Version 1
returns `PROVIDER_PERMISSION_MISSING` before network dispatch.
An active native-replay research grant has broker-local
`session.status.state="capture_only_dispatch_disabled"`,
`provider_permission_present=true`, null sync age/retry delay, and no extension status probe. Both
pending operations fail `PROVIDER_PERMISSION_MISSING`; disconnect remains available. Thus the live
grant is representable without pretending native HTTP authority exists.
Once `capture_cleanup_intent` commits, that steady-state mapping is temporarily replaced by
`session.status.state="capture_in_progress"`; pending operations and disconnect return the fixed
non-retryable `CAPTURE_IN_PROGRESS` broker error. After any terminal branch's forward retirement,
status becomes the appropriate no-grant state with `pending_browser_cleanup=true` until the marker
is cleared.

### 9.3 Capture ceremony

1. Require `native-replay` to be compiled into a developer build and require written provider
   permission specifically covering credential export and replay.
2. Require a dedicated YNAB-only profile.
3. Display the exact origin, profile instance, local binary identity, retention, and full-session
   authority warning.
4. Stop new data calls, drain every permit/outcome, stop the schedule, and obtain the old data
   host's definitive stop-and-drain ack without closing it yet. Open the credential-capture Native
   port in the sole bounded coexistence window; attest its hello and fresh worker-instance UUID and
   return a broker-generated listener epoch. Under the installation lock, generate the capture ID
   and permission-request epoch and commit the exact `CaptureCleanupIntentV1` with that
   worker/listener/request epoch and the final-gesture
   deadline at the earlier of five minutes or remaining consent/policy authorization, requiring a
   positive interval. Then deliberately close/prove absent the already-drained data port within five
   seconds and revalidate the unchanged tab/document binding. Any ambiguity performs forward
   capture retirement. The broker atomically changes the intent's permission lifecycle from
   `not_started` to `may_be_in_flight` and only then sends `NativeCapturePermissionArmedV1` carrying
   the request epoch. After validating that exact message, the worker enters permission arming,
   installs the exact capture-scoped `chrome.permissions.onAdded` and `onRemoved` callbacks, proves
   `hasListener` true for both, and only then may the popup display a separate final Capture button.
   No optional permission or catalog observer has been touched and no catalog challenge has been
   issued yet.
5. In that button's click handler set the popup-local lifecycle to `in_flight`, record the
   tuple-bound monotonic start assertion, then call
   `chrome.permissions.request` synchronously for `cookies`,
   `webRequest`, and the exact host permission before awaiting any operation. Send the closed
   popup result on the internal port after the promise settles. The worker accepts it only with the
   exact request epoch/tuple and a valid `request_started_before_deadline` assertion, then sends the
   Native permission result only after its permission-event barrier drains; that result carries the
   exact request epoch and settled lifecycle. If the request
   has not begun when `permission_gesture_before` arrives, permanently disable the button, record
   `not_started_cancelled`, drain the same event barrier, and send that settled result. The gesture
   deadline never presumes an already-started prompt settled. A request begun before the gesture
   deadline may settle afterward; at settlement the broker instead requires current consent/policy
   authorization and its own wall/monotonic/boot checks to remain valid. `exactly_granted` means the
   request resolved literal true with no `chrome.runtime.lastError`, followed immediately by
   `chrome.permissions.contains` returning true for the complete requested object and separately for
   each singleton permission and origin while the armed tuple, start assertion, current authorization,
   and target binding still match. Outcome mapping is exact: `not_started_cancelled` is terminal
   `TIMEOUT`; `resolved_false`, or `resolved_true` with an incomplete `contains` proof, is
   `denied_or_partial` and maps to `PERMISSION_REQUIRED`; `rejected` or `lastError` is terminal
   `INTERNAL`; only `resolved_true` plus all proofs is `exactly_granted`. A changed
   target/binding uses the closed `terminal` branch only after request settlement. The broker first
   commits the exact settled lifecycle into the intent. Denial, a partial/terminal result, port
   loss, or authorization expiry retires the capture; port loss before settlement preserves
   `may_be_in_flight`. On an exact grant continue without issuing the catalog challenge yet. Verify the selected
   top-level tab/document and exact origin. Require `chrome.tabs.get(tab_id).incognito === false`.
   Call `chrome.cookies.getAllCookieStores()`, select stores whose `tabIds` contains the bound tab,
   and require exactly one; this conservative uniqueness check is a NAB invariant. Record its exact
   `storeId` for the capture epoch.
6. Require the signed quiescence asset to prove the official client has completed bootstrap and no
   eligible catalog request is already in flight; the currently captured assets provide no such
   executable proof, so current capture stops here. In a future conforming build, enter `arming` and
   install the all-tabs catalog sentinel first. Any eligible request from any tab while arming sets
   a sticky preactivation flag. Then register selected-request listeners for `onBeforeRequest`,
   `onBeforeSendHeaders`, `onBeforeRedirect`, `onCompleted`, and `onErrorOccurred`, followed by
   `chrome.cookies.onChanged`. The five extraction listeners'
   `webRequest.RequestFilter` is exactly `{urls:[mode_contract.exact_catalog_url],
   types:["xmlhttprequest"], tabId: target.tab_id}`; because Chrome's filter has no method or
   initiator member, every callback separately requires `method === "POST"`, exact
   `initiator === "https://app.ynab.com"`, the bound frame/document where Chrome supplies them, and
   the same capture epoch. The sentinel filter omits `tabId` and inspects only method, initiator,
   request ID, and tab ID; it extracts no header/body. During arming it marks an eligible request
   from any tab. During active capture it immediately aborts on an eligible request from any
   nonselected tab while a selected-tab request is handled by the extraction set. Verify
   `hasListener` true for all nine exact callbacks (the sentinel, five extraction callbacks, cookie
   callback, and two permission callbacks), run the signed queue/in-flight barrier, require the
   sticky flag false and zero preexisting eligible requests, record the baseline activity
   generation, and send worker-sequence-2 `capture_observers_ready`. The broker revalidates its
   clocks/policy/binding and that closed proof, then issues broker-sequence-2 `capture_challenge`
   with the earlier-of-60-seconds/authorization deadline. On receipt, the worker requires the sticky
   flag still false and generation unchanged and atomically enters active eligible-request state;
   otherwise it sends worker-sequence-3 failure. The arming observation epoch begins only after the
   sentinel is installed; the active eligible-request epoch begins only at that atomic transition.
   `onBeforeRequest` requests no extra information and never receives
   `requestBody`: Chrome may expose the complete parsed `request_data` through `formData` and cannot
   promise original wire spelling/size there. Operation name and bootstrap-vs-sync classification
   come only from the provider-named passive application signal, which must bind the operation to the
   same client-request ID. `onBeforeSendHeaders` uses only `['requestHeaders']`—never `extraHeaders`, which
   would expose restricted cookie material to the event object—and may copy only
   `X-Session-Token`, `X-YNAB-Api-Version`, `X-YNAB-Device-App-Version`, and
   `X-YNAB-Client-Request-Id`. Cookie and Castle values are never read from request headers. The
   client-request ID is validated and retained only as transient correlation state; it is forbidden
   from the seed, Native messages, logs, errors, and durable state. Session/API headers are required;
   the observed web app-version header is required with the exact
   `observed_web_app_version_header` literal or absent under its omitted branch. It is capture/build
   compatibility metadata only and is never used as the truthful native
   `device_info_contract.ynab_app_version`. The four other web device headers are neither copied nor
   reused by native code.
7. Accept exactly one naturally generated post-bootstrap `syncCatalogData`, `syncFamilyData`, or
   `syncBudgetData` request. Do not trigger traffic merely to harvest it. `getInitialUserData` is a
   pre-active bootstrap operation whose outbound token may be provisional; observing it after the
   active transition is an immediate `PROTOCOL_CHANGED` abort. It is never ignored while the epoch
   continues.
8. Correlate all web-request callbacks by Chrome request ID. `onBeforeRedirect` for that ID aborts
   immediately before its target is accepted; no redirect response can count as completion. Copy
   only the allowlisted custom headers from step 6; require the same validated client-request ID in
   the passive application signal, but do not
   request, parse, or inspect the outgoing `Cookie` header at all.
9. Wait for both the correlated request's 2xx `onCompleted` and a provenance-named passive official-
   client application-success signal for the same client request ID proving JSON `error == null` and
   completion of session/cookie rotation. `onCompleted` alone is insufficient and the observer must
   not inspect a response body. No such safely consumable success signal is currently verified, so
   current capture aborts. On redirect, challenge, auth/application/network error, navigation, or
   missing completion, abort. After success, choose the session token strictly from the native mode
   contract: `eligible_request_header_remains_current` uses the observed outbound token; the
   `post_success_accessor` branch invokes only the named, hash-pinned accessor after the success
   signal and uses its freshly returned token. Failure/missing/ambiguous accessor output aborts; the
   pre-success header is never substituted in that branch.
10. Resolve the exact partition by calling
    `chrome.cookies.getPartitionKey({documentId: target.document_id, tabId: target.tab_id,
    frameId: 0})` and taking the returned `.partitionKey`; supplying all three IDs cross-validates
    the document/frame. Preserve Chrome's returned `topLevelSite` rather than deriving or comparing
    it to an origin. Require both partition members. Query cookies twice
    after rotation settles: first
    `getAll({url: mode_contract.exact_catalog_url, storeId})` for unpartitioned cookies, then
    `getAll({url: mode_contract.exact_catalog_url, storeId, partitionKey})` for that exact partition.
    Every first-query record must omit `partitionKey`; every second-query record must equal the
    returned key. Preserve them as the seed's two separate arrays and validate uniqueness across
    their union. Any ambiguity/conflict aborts. Record the `post_rotation` assertion with its two
    literal-one query counts, result counts, phase-bound array HMACs, and unchanged activity
    generation equal to the challenge baseline.
11. With every observer still armed, recheck the tab, document, origin, profile store, account, and
    plan binding; repeat both cookie queries once each, construct the `prestage_recheck` assertion,
    and require its counts/HMACs to match the first snapshot and validated jar; construct the closed
    `CaptureBrowserEvidenceV1` with the exact two-element snapshot tuple,
    resolved asset identities, baseline-equal activity generations, and the HMAC-bound correlation
    fingerprint; then freeze the strict-JCS seed bytes in one secret buffer and compute the exact
    `seed_jcs_sha256` and `seed_auth_tag` commitments. The executable quiescence contract
    must define a task/event barrier that drains already queued webRequest/cookie/application events,
    rereads its activity generation, and proves no relevant event occurred across the two cookie
    snapshots and serialization. There is no generic “event queue is empty” assumption.
12. Include the unexpired capture challenge and send the typed seed object plus both commitments
    once as a staged outcome. Chrome serializes the object; it does not transport the worker's
    canonical buffer. The native validator strictly parses and independently canonicalizes the
    object, verifies both commitments, retains only its own canonical representation until the
    decision deadline, performs no dispatch/storage, and returns `capture_stage_ack`.
13. While observers remain armed, repeat the binding check and both cookie queries exactly once
    after that ack; build the `poststage_recheck` assertion and require its phase-bound counts/HMACs
    and activity generation to match the staged seed, evidence, and challenge baseline. Under one
    extension state-machine lock, choose `commit` only if all remain equal and carry that assertion;
    otherwise choose `abort` with the one exact worker-owned `abort_error_code` and null assertion.
    The native validator independently verifies the commit assertion against its staged canonical
    seed before accepting it, then consumes the
    challenge, erases every secret/reference for either decision, and returns the final receipt.
14. Every received terminal receipt already contains `capture_retired:true` and the committed
    cleanup-marker ID. After validating it, put the seven catalog/cookie callbacks in terminal
    reject/drain state and prove none can mutate capture/seed state. Put the two permission callbacks
    in `cleanup_tracking` for the same request epoch: they may advance only the permission settlement
    or removal-event generation and can never mutate capture/seed state. Store
    no credential or financial value. `nab-ynab-bridge/1` permits neither seed nor native-credential
    persistence. Remove and quiesce the six webRequest callbacks plus the cookie callback, but
    retain the two permission callbacks through the cleanup port's permission-removal/event barrier.
    Erase every header/cookie/token/request/body/result reference, but retain one
    bounded in-memory cleanup registry mapping the exact `(worker_instance_id, listener_epoch)` to
    the nine callback function identities, seven literal `terminal=true` roles, and two literal
    `cleanup_tracking` roles. Those cleanup callbacks are
    static wrappers whose retained closure contains no URL, header, cookie, transaction, request ID,
    or other secret/data value. Do not remove the two permission-event listeners until cleanup has
    observed/drained final removal events; it then marks them terminal, removes them, and proves
    `hasListener=false` for all nine. The same worker opens the one cleanup-only port named by the
    receipt and uses that registry for the `hasListener=false` proof; it deletes the
    registry only after `marker_cleared`. If the worker dies first, its heap/listeners/registry die
    together and only the separately attested `old_worker_destroyed` proof is legal. A crash before
    marker projection leaves the durable capture intent, so startup still projects the obligation.
15. Treat the research grant as single-capture. For at most five seconds after a terminal receipt,
    the broker may queue exactly one matching `permission_cleanup` hello while the terminal-only
    capture host still exists; it sends no cleanup ack/challenge yet. After sending that hello, the
    worker closes the capture port. The broker proves the old capture host absent and only then
    promotes the queued cleanup port and sends its hello ack/challenge. A wrong/missing/second hello,
    capture-host ambiguity, or deadline closes the queued port and retains the marker; later normal
    cleanup may reconnect. Port loss before a receipt uses durable-intent retirement and the normal
    cleanup path. No cleanup connection is rejected merely because it raced marker publication, and
    no cleanup authority exists before the already-committed marker. Permission retention is never
    a successful capture outcome.

`capture_completion_retirement` is not `session.disconnect`, a `BrokerOperationV1`, or a synthesized
CLI request. It has no request ID/socket response and deliberately leaves the CLI pairing credential,
pairing generation/epoch, and replay cache intact. It executes before any terminal capture receipt.
Under the installation lock it atomically clears
the matching active pointer and rate schedule, consumes `capture_cleanup_intent`, creates the exact
`capture_completion` marker described in section 4.7.3, creates the matching
`capture_cleanup_pending` retired-profile record from the authenticated profile binding, and queues
grant/binding/identity/reference/cache/cursor/native-credential deletion. It then proves those local authority objects absent. The
pairing-authenticated CLI can afterward report no-grant status and invoke ordinary disconnect; it
cannot recover the retired capture grant.

Through a new cleanup-only Native host, the extension calls `chrome.permissions.remove` for exactly
`cookies`, `webRequest`, and `https://app.ynab.com/*`, then proves all three absent with
`permissions.contains`, and proves the precommitted capture listener set absent under section 8.2.
Only both proofs clear the browser marker; the retired-profile record remains until trusted deletion
or an exact same-context re-consent transition. Failure, ambiguity, or worker/browser loss leaves
the marker and no active grant, reports pending browser cleanup in the trusted capture UI, and
blocks another consent/capture until the cleanup-only flow proves absence. A crash anywhere
uses the already committed capture intent/marker forward-recovery rule; it never restores capture
authority or requires a fictitious `DisconnectResultV1`.

Capture failure classification is closed and carries no provider/page text:

| Observed terminal condition | Owner | Receipt/worker code |
| --- | --- | --- |
| provider permission absent/expired or broker-validated attestation/build/required contract asset missing/mismatched | broker only | `PROVIDER_PERMISSION_MISSING` |
| consent authorization interval ended | broker only | `CONSENT_EXPIRED` |
| wall/monotonic/boot uncertainty entered the global clock quarantine | broker only | `QUARANTINED` |
| popup `resolved_false`, incomplete true grant, optional permission revoked, or permission not exactly present | worker, broker validates | `PERMISSION_REQUIRED` |
| popup `not_started_cancelled` after its gesture-start deadline | worker, broker validates | `TIMEOUT` |
| popup request rejected/threw or reported `lastError` | worker | `INTERNAL` |
| selected tab/document/frame/origin/path/method/initiator changed or a top-level navigation occurred | worker | `WRONG_ORIGIN` |
| account, private budget, or budget-version fingerprint changed | worker, broker validates | `WRONG_ACCOUNT_OR_PLAN` |
| signed-out state, logout event, 401, or login redirect | worker | `NOT_LOGGED_IN` |
| provider security/Castle/CAPTCHA challenge | worker | `SECURITY_CHALLENGE` |
| correlated network error or 5xx without a more specific challenge | worker | `PROVIDER_UNAVAILABLE` |
| valid non-auth application error or non-auth/non-challenge 4xx | worker | `PROVIDER_ERROR` |
| accessor/success-signal execution missing or ambiguous despite a broker-valid asset; provisional-bootstrap request; missing/duplicate required header; multiple eligible tabs/requests; uncorrelated completion; incognito/ambiguous store; partition/cookie conflict; unattributable cookie/session rotation; activity-generation change; or schema/value mismatch | worker | `PROTOCOL_CHANGED` |
| seed/outcome/frame/string/cookie-count bound exceeded | worker or native validator | `RESPONSE_TOO_LARGE` |
| challenge/decision deadline elapsed or no eligible request completed before it | worker or broker; broker clocks authoritative | `TIMEOUT` |
| local listener/cookie API/native-validator failure not attributable to malformed provider/page data | worker or broker | `INTERNAL` |

`NativeCaptureErrorV1` has this complete code-to-message registry; its other two members are always
literal `retryable:false` and `retry_after_ms:null`:

| Code | Exact UTF-8 `message` |
| --- | --- |
| `PROVIDER_PERMISSION_MISSING` | `Provider authorization or the capture contract is unavailable.` |
| `CONSENT_EXPIRED` | `The capture consent expired.` |
| `QUARANTINED` | `The capture clock or local state is quarantined.` |
| `PERMISSION_REQUIRED` | `The required browser permission is unavailable.` |
| `WRONG_ORIGIN` | `The selected YNAB browser context changed.` |
| `WRONG_ACCOUNT_OR_PLAN` | `The selected YNAB account or plan changed.` |
| `NOT_LOGGED_IN` | `The dedicated YNAB profile is not signed in.` |
| `PROTOCOL_CHANGED` | `The observed YNAB capture contract did not match.` |
| `SECURITY_CHALLENGE` | `YNAB requires an interactive security check.` |
| `PROVIDER_UNAVAILABLE` | `YNAB was unavailable during capture.` |
| `PROVIDER_ERROR` | `YNAB returned an unsupported capture error.` |
| `RESPONSE_TOO_LARGE` | `The capture exceeded a configured size limit.` |
| `TIMEOUT` | `The one-shot capture deadline elapsed.` |
| `INTERNAL` | `The local capture component failed.` |

If more than one row applies, choose the first code in this exact total order:
`QUARANTINED`, `CONSENT_EXPIRED`, `PROVIDER_PERMISSION_MISSING`,
`WRONG_ACCOUNT_OR_PLAN`, `NOT_LOGGED_IN`,
`SECURITY_CHALLENGE`, `PERMISSION_REQUIRED`, `WRONG_ORIGIN`, `PROVIDER_UNAVAILABLE`,
`PROVIDER_ERROR`, `PROTOCOL_CHANGED`, `RESPONSE_TOO_LARGE`, `TIMEOUT`, `INTERNAL`. This ordering is
normative even when it differs from table order; no implementation may choose by arrival time. The
worker emits the exact fixed message/retry/null tuple only for a
`NativeCaptureWorkerFailureCodeV1`; the validator recomputes and requires it. The broker synthesizes
the three broker-only tuples itself and never accepts those codes from the worker. After staging,
the validator uses an authenticated worker `abort_error_code` only after applying the broker-owned
priority and deadline checks; a receipt may therefore carry an authoritative broker cause instead.
It never guesses why a bare abort occurred. Any code not
consistent with the observable challenged/binding/deadline state is itself `PROTOCOL_CHANGED` and
closes the port after erasing the seed.

The arming observation epoch begins atomically when the all-tabs sentinel is registered and ends
only after final receipt/timeout cleanup, never at serialization. Earlier provider state is admitted
only by the signed bootstrap/quiescence gate. The active eligible-request epoch begins at the
post-ready transition described above. Exactly one eligible catalog request may begin in that active
epoch. Any second/overlapping catalog
request, eligible request in another tab, cookie change not attributable to the single correlated
completion, session-token-changing app event, navigation, login/logout, or other activity named by
the signed `credential_quiescence_contract` aborts the epoch. The observer set watches all catalog
requests for the exact profile/store solely to detect concurrency while extracting fields only from
the selected request. The provider contract must identify the passive events proving that cookie and
session rotation are quiescent. Because `cookies.onChanged` has no request ID, a matching-store
cookie event is attributable only when the provider contract names a passive, request-ID-bound
rotation signal and an exact cookie-key/change-set that equals the observed events; otherwise even a
plausible rotation aborts. Absence of that exact contract/signal is the current hard gate. On every
success, failure, timeout, exception, navigation, or port-close path after permission settlement,
the extension removes all six `webRequest` listeners and the `cookies.onChanged` listener, then proves no callback from the epoch
can still mutate its terminal state before releasing every secret/data reference. It retains only
the nonsecret callback-identity cleanup registry from step 14 until the marker receipt or worker
destruction.
Those seven catalog/cookie listeners are quiesced before the step-15 permission-removal proof; the
two permission-event listeners remain in cleanup-tracking state until removal settles and are then
removed/proved absent. A listener teardown failure
also enters the same capture-completion cleanup-marker path; active authority is never kept merely to
retry cleanup.

Capture MUST abort on a redirect, different origin/path, provisional-bootstrap request, missing
required header, multiple eligible tabs, incognito store, partition mismatch, navigation during
capture, uncorrelated completion, or response requiring a security challenge.

### 9.4 Cookie jar rules

The native client uses a standards-compliant cookie jar. It preserves domain, host-only, path,
Secure, SameSite, expiry, store, and partition metadata; applies every `Set-Cookie` atomically after
validating the response origin; never stores a preassembled `Cookie` string; and never follows a
credentialed redirect outside the exact origin.

SameSite behavior in an extension/native client may differ from page requests. A successful one-off
replay does not establish a durable contract.

### 9.5 Future secret storage requirements

Version 1 does not persist a captured aggregate. A future version that YNAB authorizes would, at a
minimum, use a generic-password Keychain item on macOS:

```text
kSecClassGenericPassword
service = com.nab.ynab-web-session
account = opaque local session handle
kSecUseDataProtectionKeychain = true
kSecAttrSynchronizable = false
kSecAttrAccessible = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
```

That future version must also specify its encrypted record, atomic rotation, migration, retention,
and deletion contract before dispatch. Use platform equivalents elsewhere. Never use NAB JSON config, SQLite journal, argv, environment,
clipboard, browser extension storage, logs, telemetry, or a key next to encrypted ciphertext.

JavaScript cannot promise memory zeroization. Secret wrapper types must block implicit string and
JSON conversion, and the helper must minimize lifetime and copies.

## 10. Browser-catalog mode

If page snapshot cannot supply fresh/complete pending records and YNAB authorizes catalog reads,
run the fixed adapter inside a provider-designated same-origin browser realm so cookies and Castle
material never leave Chrome. The adapter owns a separate UUIDv4 and knowledge state from the normal
page and enforces the read-only profile in
[YNAB_CATALOG_PROTOCOL.md](./YNAB_CATALOG_PROTOCOL.md).

### 10.1 Execution-realm gate

The current evidence does not establish a safe realm. An extension service worker has an extension
origin and different CORS/cookie/Origin behavior; an ordinary YNAB app tab runs its own writable
sync/import pipeline; and an offscreen extension document is also not `app.ynab.com`. It is further
unknown whether calling `getInitialUserData` with a page/meta seed rotates or invalidates the normal
page's token or whether the seed is reusable across a second device.

Therefore `browser-catalog` MUST return `PROVIDER_PERMISSION_MISSING` before private network
dispatch until the signed provider policy identifies all of the following: one exact top-level
same-origin bridge URL, how the fixed packaged MAIN-world adapter is installed at `document_start`,
how it obtains and atomically rotates its own session token, how it obtains a fresh Castle token per
request under the executable `browser_castle_contract`, exact Origin/Referer/
`X-Requested-With` behavior, and confirmation that no official writable
`SyncManager`/automatic importer runs in that realm. It must also define the stateful, closed
MAIN-to-worker token-decision channel identified by `stateful_token_channel_contract`; an ordinary
`executeScript` return value has no continuation and cannot satisfy it. A normal application tab is not an acceptable
substitute.

Once supplied, the only conforming realm is a dedicated NAB profile with one top-level tab at that
policy-pinned URL. The extension injects one fixed reviewed MAIN-world network adapter; that adapter
constructs the four allowlisted HTTP requests, owns session/Castle material, and returns only the
secret-stripped wire outcome in section 10.3. The service worker owns orchestration, raw entity maps,
cursors, decoding, normalization, and validation. Any navigation, extra
eligible tab, origin/path/build/schema/account/plan change, or security challenge destroys the
session and discards its device state. No service-worker or offscreen-document fetch fallback exists.

Installation is exactly one dynamic script whose packaged path/hash equals
`mode_contract.adapter_asset` and whose read-back object is:

```json
{
  "id": "nab-ynab-browser-catalog-v1",
  "matches": ["https://app.ynab.com/*"],
  "js": ["browser-catalog-adapter-v1.js"],
  "allFrames": false,
  "world": "MAIN",
  "runAt": "document_start",
  "persistAcrossSessions": false
}
```

No other field or registration is allowed. The adapter immediately refuses any URL other than the
exact signed realm URL. Registration occurs only after its preparation-scope cleanup record is
durable; it remains registered only for the life of that realm so an unexpected reload still starts
the reviewed guard at document start. Expiry, rollback, renewal, and disconnect must prove both the
registration absent and every exact-origin dedicated-profile document absent. Closing a document
alone is never installation teardown.

It MUST NOT call the official page's `syncManager`, because that manager uploads unsaved official
page changes and auto-imports raw transactions. It MUST NOT share the official page device ID or
knowledge counters.

Only normalized results cross Native Messaging. The bridge provides no `catalog.call`, raw response,
or token method.

Identity validation is mandatory before each candidate merge/cursor commit. The worker HMACs the
initial response's `user.id` and requires the bound account fingerprint before issuing the bootstrap
token commit. After catalog candidate merge it requires every active input relation to name that
same user and exactly one candidate to HMAC-match both the consent-bound private-budget and
plan-version fingerprints. Zero or multiple matches fail before any family or budget request. Family singleton
and member IDs and returned `be_budget.id`/`budget_id` follow the exact checks in the core protocol.
An initial bound-user HMAC mismatch returns `WRONG_ACCOUNT_OR_PLAN`. A complete catalog map with zero
matching budget/version tuples is `PERMISSION_DENIED`; more than one is `PROTOCOL_CHANGED`. The raw
relation-row ID is not consent authority, so replacement with exactly one active same-tuple row is
accepted exactly as the core defines. Family/budget singleton mismatches use the core's
`PROTOCOL_CHANGED`/`PERMISSION_DENIED` distinction. Every failure advances no cursor, destroys the
candidate/device as specified, and never searches other relations or accepts a caller raw ID.

### 10.2 Exact state lifetime

One long-lived Native Messaging port defines one browser-catalog session and one fresh logical
device. A single-writer lock covers catalog, family, and the selected budget. The service worker
holds the logical device, knowledge states, raw entity maps, completeness flags, and pending indexes
only in memory; a live native port keeps the worker active. It MUST NOT put raw financial entities,
cookies, session tokens, device state, or cursors in `chrome.storage`, IndexedDB, Cache Storage, or a
filesystem.

After bind, the broker scheduler—not a CLI request—issues at most one initialization run for that
logical device. The mode
creates a new UUID and zero knowledge, then performs exactly one
ordered initialization: session bootstrap, catalog, optional family, budget bootstrap, and budget
backfill. This is four physical requests without family and five with family and MUST fit the signed
`maximum_initialization_requests`. It exposes no result before the backfill commit. A later refresh
is catalog, optional family, and budget delta—two or three physical requests—and MUST fit
`maximum_refresh_requests`. Simultaneous scheduler work coalesces onto one in-flight promise. The
fixed outbound validator requires the operation allowlist, exact origin/path, this session's device
ID, `Kc = Ks = 0`, and a recursively exact-empty change set immediately before serialization.

Native-port disconnect, service-worker termination, browser exit, identity change, schema change, or
quarantine destroys all in-memory entities and cursors. A later connection starts with another UUID
and zero bootstrap/backfill; it never reconstructs a cursor without its entity cache.

To prevent reconnect loops and rolling-hour excess, the broker persists only the nonsecret
`RateStateV1` and authenticated envelope specified in sections 4.7.2 and 4.7.5. Before every
scheduler run it atomically reserves the signed maximum whole burst in the one installation-wide
record. The run is forbidden if the resulting rolling slot-count would exceed
`maximum_requests_per_hour`. Failed requests and any future provider-approved retry count exactly
like successful requests; skipped/unused reserved slots also remain counted. Reconnecting, renewing
the sole grant, creating a profile, or creating a device cannot reset the counter. Financial bodies,
private/public provider IDs, URLs, logical/client request IDs, and credentials are forbidden from
that record. The exact boot/clock, corruption quarantine, atomic commit, migration, and key-lifetime
rules are those in section 4.7; there is no second scheduler storage representation.

The broker owns cadence/rate scheduling and the service worker is the single-run executor described
in section 8.2. Initialization is eligible immediately after successful activation only when both
`latest_burst_started` and `cadence_not_before` are null. Rebind, renewal, and fresh consent all
compute `next_eligible_dispatch = max(cadence_not_before, provider_not_before,
rate_quarantine_deadline)` using the exact persisted/re-armed deadlines. `latest_burst_started` is
not itself an eligibility shortcut; it exists to extend `cadence_not_before` when a newly authorized
policy has a longer interval. The reservation transaction records the next start-to-start cadence deadline before the run is emitted; run
duration never shifts it. After success, `next_due` remains that start-to-start deadline; failure transitions in section 10.4 either set
that same bounded formula or set `next_due = null`. A past `last_success` can never cause an
immediate loop. At `next_due`, one
single-flight refresh may start only if the dedicated realm, live grant, rate budget, and provider
delay permit it. A browser close or missing realm prevents the scheduled attempt; it does not create
a polling/reconnect loop. Pending calls are memory-only reads and MUST NOT trigger, accelerate, or
retry private synchronization. If their newest committed snapshot exceeds the grant's age ceiling,
they return `STALE_DATA` until a later scheduler-owned success. A required delay reports
`RATE_LIMITED` only through initialization/status control; it never causes a pending call to
dispatch.

If the Native port, worker, or tab dies after possible dispatch, a non-bootstrap waiting operation
receives `READ_RESULT_UNKNOWN`; ambiguous bootstrap/token rotation is
`SESSION_STATE_UNKNOWN`. All memory is discarded, the device is never replayed/reused, and the next
fresh-device initialization remains subject to the scheduler/rate record above.

Every document cache is checked after a candidate merge and before cursor commit against the signed
entity and RFC 8785 JCS UTF-8 byte limits in `cache_limits`. Tombstones count. Exceeding either limit
rejects the candidate, leaves the prior cursor/cache unchanged, destroys the logical device, and
returns terminal `RESPONSE_TOO_LARGE`; records are never evicted or truncated to
manufacture success.

This version deliberately has no persistent browser-catalog cache. A future persistent mode is a
separate protocol version and must define encryption, identity binding, atomic entity/cursor commits,
crash recovery, migration, deletion, and concurrency before use.

### 10.3 MAIN network adapter boundary

The service worker invokes one fixed MAIN function with this closed internal request; callers cannot
construct it directly:

```ts
type CatalogBrowserRequestV1 = {
  schema: "nab.catalog-browser-request/1";
  logical_request_id: string;
  operation: "getInitialUserData" | "syncCatalogData" | "syncFamilyData" | "syncBudgetData";
  device_id: string;
  request_data: GetInitialUserDataRequest | SyncCatalogDataRequest |
                SyncFamilyDataRequest | SyncBudgetDataRequest;
  expected_form_utf8_bytes: number;     // safe positive integer from normative serializer
  expected_form_sha256: string;         // lowercase SHA-256 of exact final form bytes
};

type CatalogBrowserOutcomeBaseV1 = {
  schema: "nab.catalog-browser-outcome/1";
  logical_request_id: string;
  client_request_id: string;
  operation: "getInitialUserData" | "syncCatalogData" | "syncFamilyData" | "syncBudgetData";
  server_version: string | null;
  response_body_utf8_bytes: number | null; // null only when dispatch was proven not to occur
};

type InitialUserDataWithoutSecretsV1 = {
  error?: null;
  user: ActiveCatalogUserWire;
  user_budget?: UserBudgetWire | null;
  budget_version?: JsonObject | null;
};

type KnownPrivateApplicationErrorIdV1 =
  | "server_knowledge_of_device_exceeds_device_knowledge"
  | "user_does_not_have_read_permissions"
  | "user_does_not_have_family_read_permissions"
  | "client_app_update_required";

type CatalogBrowserSuccessOutcomeV1 = CatalogBrowserOutcomeBaseV1 & (
  | {
      ok: true;
      operation: "getInitialUserData";
      dispatch: "response_definitively_received";
      http_status: number;              // integer 200..299
      response_media_type: "application/json";
      session_token_staged: true;
      castle_state_staged: true;
      response_without_secrets: InitialUserDataWithoutSecretsV1;
    }
  | {
      ok: true;
      operation: "syncCatalogData";
      dispatch: "response_definitively_received";
      http_status: number;              // integer 200..299
      response_media_type: "application/json";
      session_token_staged: false;
      castle_state_staged: false;
      response_without_secrets: SyncResponse<CatalogChangedEntitiesResponse>;
    }
  | {
      ok: true;
      operation: "syncFamilyData";
      dispatch: "response_definitively_received";
      http_status: number;              // integer 200..299
      response_media_type: "application/json";
      session_token_staged: false;
      castle_state_staged: false;
      response_without_secrets: SyncResponse<FamilyChangedEntitiesResponse>;
    }
  | {
      ok: true;
      operation: "syncBudgetData";
      dispatch: "response_definitively_received";
      http_status: number;              // integer 200..299
      response_media_type: "application/json";
      session_token_staged: false;
      castle_state_staged: false;
      response_without_secrets: SyncResponse<BudgetChangedEntitiesResponse>;
    }
);

type CatalogBrowserFailureBaseV1 = CatalogBrowserOutcomeBaseV1 & {
  ok: false;
  session_token_staged: false;
  castle_state_staged: false;
};

type CatalogBrowserFailureOutcomeV1 = CatalogBrowserFailureBaseV1 & (
  | {
      dispatch: "definitely_not_dispatched";
      http_status: null;
      server_version: null;
      response_body_utf8_bytes: null;
      failure: {
        class:
          | "local_predispatch_timeout" | "local_predispatch_internal"
          | "request_too_large" | "write_guard_violation"
          | "realm_or_navigation_mismatch";
        known_error_id: null;
        retry_after_ms: null;
      };
    }
  | {
      dispatch: "response_definitively_received";
      http_status: number;
      response_body_utf8_bytes: number;
      failure: {
        class: "http_throttled" | "http_service_unavailable_with_delay";
        known_error_id: null;
        retry_after_ms: number;          // safe non-negative integer, full validated delay
      };
    }
  | {
      dispatch: "response_definitively_received";
      http_status: number;
      response_body_utf8_bytes: number;
      failure: {
        class:
          | "http_auth" | "http_permission"
          | "http_server_error" | "unexpected_http_status"
          | "security_challenge" | "invalid_content_type" | "invalid_json"
          | "response_too_large";
        known_error_id: null;
        retry_after_ms: null;
      };
    }
  | {
      dispatch: "opaque_redirect_received";
      http_status: null;
      server_version: null;
      response_body_utf8_bytes: 0;
      failure: {
        class: "login_redirect";
        known_error_id: null;
        retry_after_ms: null;
      };
    }
  | {
      dispatch: "response_definitively_received";
      http_status: number;
      response_body_utf8_bytes: number;
      failure: {
        class: "application_error";
        known_error_id: KnownPrivateApplicationErrorIdV1 | null;
        retry_after_ms: null;
      };
    }
);

type CatalogBrowserOutcomeV1 =
  | CatalogBrowserSuccessOutcomeV1
  | CatalogBrowserFailureOutcomeV1;

type CatalogBrowserTokenDecisionV1 = {
  schema: "nab.catalog-browser-token-decision/1";
  logical_request_id: string;
  decision: "commit" | "abort";
};

type CatalogBrowserTokenAckV1 = {
  schema: "nab.catalog-browser-token-ack/1";
  logical_request_id: string;
  decision: "commit" | "abort";
  completed: true;
};
```

`InitialUserDataWithoutSecretsV1` is a closed projection: `session_token`, `castle_user_jwt`, help/
support JWTs or hashes, and any provider field classified as credential/security state by the exact
response registry are forbidden even when null. MAIN may stage only `session_token` plus the browser
security state named by `browser_castle_contract`; every help/support secret is discarded. The
Castle contract must define whether bootstrap Castle state is required/optional, its exact input
field/type, initialization and rotation, how one request-bound Castle token is issued for each
physical request, challenge/failure semantics, and commit/abort/destruction behavior. It cannot
permit a token accessor or expose raw Castle state outside the MAIN closure. Missing contract bytes,
an unregistered security field, or an unexpected absence/presence destroys the realm before another
request.

The token decision/ack types describe a required state machine, not an assumed Chrome primitive.
The signed `stateful_token_channel_contract` must bind one long-lived adapter instance to the exact
Native port nonce, target document ID, realm build, and logical request ID; keep provisional/active
tokens inside a non-page-readable adapter closure; accept exactly one authenticated `commit` or
`abort`; reject duplicate/out-of-order/other-request decisions; and return the one matching ack.
It may expose neither a page-global command surface nor a caller-selected operation/token accessor.
Adapter/document/worker death at any point follows the ambiguity rules below. No currently verified
Chrome/YNAB realm supplies that mechanism. The decision payload and ordering are closed here, but
transport, closure lifetime, authentication, Castle-state integration, and teardown remain an unresolved provider/runtime
contract. Browser-catalog therefore remains gated; these prose requirements are not a substitute
for the canonical bytes named by `stateful_token_channel_contract`.

Before invocation the service worker performs the core exact-empty/device/cursor/schema checks,
constructs the exact core serializer body, and fills its length/digest. MAIN repeats the operation/
origin/path/method/version/device/change-set checks and independently reconstructs the RFC-8785/
WHATWG form bytes. It compares both length and digest before any transport call. An agreed exact-
empty body above the policy maximum returns `request_too_large`; any disagreement or unprovable
change set returns `write_guard_violation`. Both are definitely pre-dispatch, but the latter always
destroys/quarantines the device. Only after those checks MAIN generates a fresh client
request ID and Castle token and uses its internally held rotating session
token and ambient cookies. It never follows a redirect. It accepts a response only when the parsed
media type is `application/json` (ASCII case-insensitive) with no parameter or only
`charset=utf-8` (case-insensitive); every other parameter/media type is
`invalid_content_type`. An absent `Content-Encoding` is `identity`; a present encoding must be one
exact signed-policy value, with multiple/stacked/unknown encodings rejected. Browser fetch exposes
post-content-decoding bytes, so MAIN reads the response as a bounded byte stream, aborts when
`response_body_max_bytes` would be exceeded, and decodes incrementally with fatal UTF-8 semantics;
it MUST NOT use `Response.text()`, which may replace malformed input. The reported byte count is the
post-content-decoding byte count before character decoding. A future native transport also caps raw
encoded bytes before decompression at `response_encoded_body_max_bytes`, then enforces the same
decoded ceiling and fatal decoder. Duplicate-key, trailing-token, lexical-number, JSON,
2xx/application-success, and secret
stripping checks follow the core contract. No header/cookie/token accessor exists.

Failure outcomes are secret-free and closed. With Fetch `redirect: "manual"`, MAIN first checks
`Response.type`: `opaqueredirect` maps only to the closed redirect branch above because Fetch hides
its actual 3xx status, headers, and body. That branch has null status, zero body bytes, no server
version, proves dispatch but no readable application response, destroys the realm/device, and maps
to `SESSION_EXPIRED`; it is never parsed as JSON. Otherwise `http_status` is null exactly for proven
pre-dispatch failure and is the received integer status in `100..599`. `http_throttled` is exactly
status 429; `http_service_unavailable_with_delay` is exactly 503; their delay is required, fully
validated, and bounded by policy. A 503 without such a delay is `http_server_error`; that class
covers every other 5xx. `http_auth` is exactly 401. `http_permission` is an unrecognized-body 403;
budget/catalog denial maps to permission loss while an unrecognized family 403 is provider error.

The top-level `error` member uses the exact closed lexical decoder in the core protocol section 14.
A string can never supply an ID. For an object, only its own exact `id` member can do so; unknown
members/types/bounds are malformed, and message/data are always destroyed. On 2xx, absent/null error
is the only success shape; any valid non-null string/object selects `application_error`, with
`known_error_id=null` for an unknown ID. On non-2xx, a valid object containing one of the four exact
known ID literals selects `application_error` so context can be checked; unknown/string/malformed
body content is discarded and status mapping wins. The complete context table is:

| Known ID | Allowed operation/status | Mapping |
| --- | --- | --- |
| `server_knowledge_of_device_exceeds_device_knowledge` | any of the three `sync*` operations; 200..299 | `QUARANTINED`, destroy device, no cursor/retry |
| `user_does_not_have_read_permissions` | `syncCatalogData` or `syncBudgetData`; 200..299 or 403 | `PERMISSION_DENIED` |
| `user_does_not_have_family_read_permissions` | `syncFamilyData`; 200..299 or 403 | bound family-disabled branch only |
| `client_app_update_required` | any fixed operation; 426 | `PROTOCOL_CHANGED` |

A known literal in any other operation/status context maps to `PROTOCOL_CHANGED`, destroys the
logical device, and advances no cursor. No bare 426 is update-required; with no valid known ID it is
`unexpected_http_status`. Every `CatalogBrowserSuccessOutcomeV1.http_status` is validated as
200..299 before construction. `response_too_large` reports
`response_body_utf8_bytes = response_body_max_bytes + 1` as a nonsecret overflow sentinel; every
other received branch reports the exact bounded bytes consumed. For every readable JSON status, the
bounded duplicate-key-aware error decoder runs before branch selection, but exposes only the closed
pairs above. `known_error_id` is non-null only in the application-error branch and carries only one
of the four allowlisted identifiers above; it is null only for a valid 2xx unknown application
error. Unknown IDs/
messages/data and raw provider response text are discarded. A thrown exception after possible dispatch produces no outcome and maps to
`SESSION_STATE_UNKNOWN` for bootstrap or `READ_RESULT_UNKNOWN` for every other operation.

`Retry-After` is accepted only as one or more ASCII decimal digits representing delta-seconds; no
sign, whitespace after header-value normalization, fraction, comma/list, or HTTP-date is accepted.
It is parsed lexically with arbitrary precision before multiplication by 1,000 and conversion. Zero
is valid and records a provider deadline at the response-time sample with zero added delay, but it
never deletes or shortens an already committed cadence, rolling-hour, or quarantine deadline. The
broker maps the result using the exact maximum-deadline/remnant calculation in section 7.4; hence a
public `RATE_LIMITED.retry_after_ms` can also be zero when all other deadlines have elapsed. No
immediate HTTP retry occurs; only a later broker scheduler decision may create a new operation. A
value above `maximum_retry_after_ms`, above the safe-integer range, or otherwise unrepresentable is
never clamped downward: scheduling stops as `PROVIDER_ERROR` pending provider review and no private
dispatch occurs. A valid value is honored in full. The signed maximum is a compatibility/representation
bound, not permission to shorten a provider delay.

Bootstrap credential rotation uses two phases because MAIN and service-worker state cannot share one
atomic transaction. MAIN validates the response, removes every secret from the returned body, and
stages—but does not activate or expose—the returned session token and exact contracted Castle state
as one credential-state candidate. It blocks every further catalog request for that realm. The
worker requires `session_token_staged=true` and `castle_state_staged=true`, validates the complete
success outcome, and stages its candidate user and
zeroed device state, then sends exactly one `CatalogBrowserTokenDecisionV1`. A definitively received
bootstrap may already have changed remote session state, so `abort` deletes every provisional and
staged session/Castle object, destroys the realm/device, and enters `SESSION_STATE_UNKNOWN`; it never pretends to
roll the server back or reuse the provisional token. On `commit`, MAIN swaps the
complete staged credential state into the active slot, deletes the prior session/Castle state, and
returns the matching ack; only after
that ack does the worker publish its candidate local state and permit catalog sync. Any exception,
port loss, navigation, or worker death after a commit decision could have been delivered but before
both sides finish enters `SESSION_STATE_UNKNOWN`, destroys the dedicated realm/device, and requires
interactive reconnect. No implementation may guess which token is active.

For non-bootstrap success, the service worker validates the complete outcome and applies it to its
in-memory entity/cursor transaction. `response_body_utf8_bytes` must equal MAIN's pre-parse UTF-8
measurement and remain within the signed limit. Missing/mismatched request ID or operation, a secret
field surviving stripping, an unknown outcome field, or impossible failure discriminator fails
closed. Once ready, the worker builds the same final normalized records as section 5.2 directly from
its entity maps and keys. Only those `BrowserPending*` types cross Native Messaging.

After the table's contextual application mappings, deterministic failure mapping continues as
follows. Auth/login maps to `SESSION_EXPIRED`; 429/valid provider delay maps to `RATE_LIMITED` with
the broker-computed effective remaining eligibility delay (not merely the raw header); 5xx maps to
`PROVIDER_UNAVAILABLE`; any other definitively received non-2xx status to redacted non-retryable
`PROVIDER_ERROR`; challenge to `SECURITY_CHALLENGE`; oversize to `RESPONSE_TOO_LARGE`; invalid
content/JSON or unknown application error to `PROTOCOL_CHANGED`/`PROVIDER_ERROR` respectively. A
proven pre-dispatch local timeout is `TIMEOUT`; request-size excess is `RESPONSE_TOO_LARGE`;
write-guard violation is `AMBIGUOUS_COMMIT` plus permanent device destruction even when local code
proves no dispatch; and realm/navigation mismatch is `WRONG_ORIGIN` or
`WRONG_ACCOUNT_OR_PLAN` according to the failed bound check. Only
`local_predispatch_internal` maps to redacted non-retryable `INTERNAL`. No outcome authorizes an immediate automatic
HTTP retry.

### 10.4 Scheduler result transitions

The broker persists `next_due`, a one-bit `predispatch_retry_used` flag, and the redacted terminal
state. Only the broker timer may start a later run on an already valid bound realm; it cannot create,
attest, probe, or bind a replacement realm/document.

| Run outcome | Initialization | Refresh with prior ready snapshot | Later automatic run |
| --- | --- | --- | --- |
| complete success | expose ready only after backfill; clear failure flag | commit successful documents; update budget success age | retain the start-to-start `next_due` committed from the burst reservation, extended only by a later provider deadline |
| valid rate/provider delay before any dispatch | retain current unexposed/ready state | retain prior ready budget snapshot | one new normal run at `max(provider deadline, cadence deadline)`; status is `rate_limited` only when no usable ready snapshot |
| definitive 429/503 with valid delay after dispatch | destroy only the partial logical device/cache; retain the exact already-attested bound realm and its definitive credential state | retain the prior committed budget snapshot/cursor and the exact bound realm; already committed catalog/family state is usable only after identity checks stayed stable | fresh initialization or full refresh on that same realm at the same maximum deadline; no realm creation/replacement |
| `local_predispatch_timeout` or `permit_expired_unused` during initialization | destroy the initialization realm/device, set the flag and `provider_error`, preserve rate deadlines | not applicable | none; the immutable target is now unavailable and only foreground renewal/re-consent may create and attest a new realm/device under the recovery contract |
| `local_predispatch_timeout` or `permit_expired_unused` during refresh | not applicable | retain the prior ready snapshot/cursors and the exact still-bound realm/device; set the flag | exactly one later run on that same realm/device after `next_eligible_dispatch`; a second consecutive occurrence stops as `provider_error` with `next_due = null` |
| handled family-permission error | set/retain `family_unavailable_for` and continue the same run to budget | same | ordinary success cadence if budget succeeds |
| auth/login/session-expired | destroy realm/device and all cached data | destroy realm/device and all cached data | none; interactive reauthentication/reconnect |
| budget permission, consent/provider-policy expiry | destroy grant/device/cache | destroy grant/device/cache | none; new consent/provider authorization as applicable |
| local predispatch internal error, request-size excess, realm/navigation mismatch, 5xx without a valid delay, unknown app error, invalid content/JSON, challenge, response/cache limit, schema/version/identity/cursor violation | destroy partial device; retain only redacted state | stop serving private data; destroy device/cache | none; provider review/reconnect or new compatible release |
| `SESSION_STATE_UNKNOWN`, `READ_RESULT_UNKNOWN`, write-guard violation, or control-port ambiguity | destroy realm/device/cache | destroy realm/device/cache | none; explicit recovery path only |

For refresh rows that say “retain prior snapshot,” pending reads remain `ready` only while that
snapshot satisfies the consent age ceiling; afterward they become `stale`. A terminal error row
takes precedence over cached data and does not serve it. `next_due = null` means no timer, and neither
status nor a pending call can recreate one. A reconnect is allowed only where the row explicitly
names it and still obeys the installation-wide rate record; it never resets a delay or counter.

## 11. Future direct-replay state and ambiguity

This section is a provider-contract target, not permission to dispatch under section 9.2. A future
authorized direct reader still has transactional state and would persist one record per
account/document/device:

```ts
type KnowledgeStateV1 = {
  schema_version: number;
  schema_version_of_knowledge: number;
  current_device_knowledge: number;
  server_knowledge_of_device: number;
  device_knowledge_of_server: number;
  initialization: "empty" | "bootstrap_partial" | "ready" | "quarantined";
};
```

This type is not a Version 1 storage format. `nab-ynab-bridge/1` MUST NOT instantiate or persist it;
section 9.3 stores no seed or native credential and section 9.2 forbids dispatch. Encrypted record
layout, keys, transaction boundaries, recovery, deletion, and migrations require a new protocol
version before any native-replay persistence exists.

For this fresh read-only logical device,
`current_device_knowledge == server_knowledge_of_device == 0` for its entire lifetime. The final
outbound interceptor also requires an exactly empty change set. A positive server acknowledgement,
even if equal to the local value, indicates device reuse or a changed contract and quarantines.

Entity data MUST be durable before advancing `device_knowledge_of_server`. Either of these crash
strategies conforms:

- commit entities and final cursor in one transaction; or
- commit idempotent entity replacements with the old cursor, then commit the advanced cursor in a
  second transaction. A crash replays the same replacements.

Do not advance the cursor first.

Ambiguity states:

- Lost response after a read-only sync was dispatched: retain old cursor and enter
  `READ_RESULT_UNKNOWN`. Local entity replacement would be idempotent, but server-side replay/device
  acknowledgement semantics are unverified, so this version does not automatically replay. Resume
  only through a provider-approved recovery rule or an interactive fresh-device bootstrap.
- Lost response to `getInitialUserData`, which may rotate the session token: enter
  `SESSION_STATE_UNKNOWN` and recapture in the browser.
- Any request whose final serialized change set was not provably empty: enter `AMBIGUOUS_COMMIT`,
  permanently destroy/discard that logical device and all of its private cache/cursors, retain only
  the broker-owned redacted ambiguity state, and require human/provider-guided recovery. The device
  is never unquarantined or reused; the ambiguity state is intentionally not clearable by an agent.

## 12. Logging and telemetry contract

Allowed events:

- consent grant/revoke;
- operation class;
- duration and result count;
- redacted error code;
- component/schema versions;
- salted opaque local fingerprints.

Forbidden everywhere, including errors and crash reports:

- `Cookie`, `Set-Cookie`, cookie values/names if sensitive;
- session, Castle, device, client/server request tokens;
- JWTs and password/MFA fields;
- request/response/native-message bodies;
- real account/plan/entity IDs;
- payees, memos, amounts, balances, category names;
- selected-tab URLs beyond the constant origin/path;
- screenshots and network traces.

Automated tests place secret canaries in every secret field and scan stdout, stderr, structured logs,
exceptions, traces, test snapshots, and crash-report payloads.

## 13. Disconnect and revocation

`session.disconnect` has two closed branches. With no live grant it is accepted only when
`active`, `candidate`, `browser_preparation`, `capture_cleanup_intent`, `schedule`, and every
data/transient Native host are
already absent; the three browser booleans are false as section 7.3 requires. It stops new calls,
loads the scoped pairing key, proves the scheduler/consent/binding/cache/native credential already
absent, performs the forward-only pairing retirement/deletion from live-branch step 10, authenticates
the response with the scoped key, and closes sockets. It does not alter a tombstone, cleanup marker,
retired profile, browser, provider session, or installation-wide rate state. Its report is exactly:
`stop_new_calls`, `stop_browser_scheduler`, `delete_consent`,
`delete_binding_and_reference_keys`, `delete_cache_and_cursors`, `delete_native_credential`, and
`delete_pairing` are `completed`; `teardown_browser_mode` is `not_applicable`; every other optional
step is `not_requested`; every entry has `blocked_by=null`; `local_authority_revoked=true`; and
`provider_session_revocation="not_requested"`. A candidate/preparation/host ambiguity must first be
resolved by its foreground rollback/cleanup state machine and is never erased by this branch.

With a live grant, `session.disconnect` performs, in order:

1. stop accepting new broker calls;
2. directly read/verify the one fixed pairing credential and load one scoped in-memory copy of its
   pairing key for this response only. Failure occurs before any authority/browser mutation, restores
   the call gate, and returns no structured disconnect result because no response MAC can be made;
3. acquire the session sync lock, send `NativeStopAndDrainV1`, stop the worker scheduler before it
   can begin another dispatch, and wait for the closed ack. An in-flight request must reach a
   definitive handled outcome or the worker must destroy the device and acknowledge ambiguity. If
   the port is already dead, record the applicable ambiguity state and prove no scheduler remains;
   never delete authority while an autonomous worker can still dispatch;
4. mark the requesting connection as closing but keep it open for the final response;
5. commit one authority+rate transaction that makes the consent/binding inactive; this is the
   authority-revocation point. Always create the closed `disconnect` cleanup marker from the active
   mode cleanup obligation before retiring it; its permission set is empty when permission removal
   was not requested. If logout was requested and an accepted executable logout asset exists, persist
   that exact obligation in the marker; otherwise persist null and precompute the fixed failed logout
   step. When dedicated-profile deletion was requested, create
   `retired_profile` with reason `disconnect_cleanup_pending` before dropping the active pointer.
   Queue—but do not yet execute—the per-grant key/file deletion;
6. when profile deletion was requested, construct, flush, verify, and OS-register the authenticated
   one-shot job from `retired_profile` while the original binding/process evidence remains available.
   Registration failure leaves `retired_profile` and no authority, enabling only the trusted retry
   path in section 4.7.6;
7. over the drained still-bound cleanup port, attempt the exact persisted provider logout first when
   present, then hard-close the observer/realm documents, remove the exact optional host/cookie/
   webRequest permissions when requested, and clear the marker only after the complete cleanup ack.
   A requested logout with null, evidence-only, wrong-kind, or unknown-schema asset performs no
   navigation/request and reports the `provider_logout` step failed with
   `PROVIDER_PERMISSION_MISSING`; local revocation and remaining browser cleanup continue. This
   temporary cleanup path cannot serve data or dispatch catalog requests;
8. close only the NAB-launched Chrome process for that exact dedicated profile when profile
   deletion was requested and explicitly confirmed; never close any process whose saved dedicated-
   profile binding is not proved, and never treat provider logout as permission to close Chrome;
9. delete the protected grant-record key (cryptographic erasure), binding ciphertext, identity/
   reference keys, normalized cache/cursors, and any native-replay credential, then durably complete
   their deletion intents;
10. commit `active_pairing = null` plus `pairing_retirement` naming the exact old credential while
    leaving its replay pointer referenced; this forward-only commit makes the broker non-runnable.
    Delete the fixed item only by exact service/account/digest match and re-read confirmed absence;
    an indeterminate delete is always resolved by direct re-read. Then commit replay/retirement null,
    queue and complete deletion of the old replay key/file, and require no associated deletion intent
    remain. Compose and authenticate `DisconnectResultV1` with the scoped in-memory pairing-key copy,
    write and flush it on the requesting socket, zero/free the scoped copy as far as the
    implementation language permits, then close every local and Native Messaging connection. A
    crash at any boundary is completed forward by startup and can never restore pairing; it may mean
    the requested disconnect took effect without a response;
11. perform any scheduled post-exit profile deletion through the preinstalled one-shot job;
    because it occurs after the response, its result is `scheduled`, not falsely reported complete.

A structurally valid `BrowserDisconnectResultV1` is mapped field-for-field into the three matching
`DisconnectStepResultV1` entries: `status` is copied, and a failed nested `error_code` is copied
exactly into the broker report. `not_applicable` is legal only for native-replay's null mode cleanup;
each `not_requested` is legal only when its controlling request flag was false. Provider-session
revocation is `not_requested` iff logout was not requested, `confirmed` only with completed logout
and the separately verified signed revocation proof, and otherwise `not_confirmed`. A malformed/
unknown nested object maps every requested unresolved browser step to failed `PROTOCOL_CHANGED`; a
cleanup-port loss maps it to `BROWSER_UNAVAILABLE`; and a broker-enforced cleanup deadline maps it to
`TIMEOUT`. Already authenticated per-step completions in a valid response remain completed. In all
three transport-failure cases the marker is retained, so no inferred success is possible and each
attempted failure has the exact non-null code required by the final report.

Failure control flow is closed and independent of report ordering:

| Boundary/step | On failure | What may still run | Required report/state |
| --- | --- | --- | --- |
| `stop_new_calls` | An accepted disconnect sets this in-memory gate atomically; inability to do so is an outer `INTERNAL` failure before a `DisconnectResultV1` exists | nothing | no mutation; original authority remains |
| pairing-key load | authentication cannot be completed | nothing | no structured result; original authority and scheduler remain; call gate restored |
| `stop_browser_scheduler`/drain proof | pre-authority barrier fails | nothing that can retire authority or touch browser state | this step `failed`; every requested downstream step except already-`not_requested` options is `blocked` by it; original grant remains but broker stays closed/quarantined until restart or trusted disconnect retry; `local_authority_revoked=false` |
| atomic `delete_consent` authority transaction | active pointer/marker/rate transition did not commit | nothing downstream | this step `failed`; every requested later step is `blocked` by it; original grant remains closed/quarantined; `local_authority_revoked=false` |
| browser teardown, permission removal, or provider logout after authority revocation | that exact browser/provider obligation is unresolved | the other browser obligations and all local erasure steps continue | failed step retains the cleanup marker; it does not block independent local erasure or pairing deletion |
| `install_profile_deletion_job` | no proven registered helper exists | browser cleanup and local erasure continue; browser close/profile deletion do not | job `failed`; requested `close_browser` and `delete_dedicated_profile` are `blocked` by the job |
| `close_browser` | exact saved process did not close | local erasure continues | close `failed`; requested profile deletion is `blocked` by close; registered job/retired-profile state remains for trusted retry |
| any of the three local grant-data erasures | its durable absence proof failed | attempt the other two erasures and browser cleanup; do not delete pairing | attempted step `failed`; `delete_pairing` is `blocked` by the first failed local-erasure step in report order; deletion intent remains for startup completion |
| `delete_pairing` | exact item/retirement/replay absence was not proved | compose the response with the already loaded scoped key; startup continues forward | step `failed`; `local_authority_revoked=false`; active grant remains absent and the broker cannot serve data |
| response write/flush | caller may not learn the result | startup/one-shot helper continues forward | no rollback; the same authenticated state determines any later trusted status/cleanup view |

An unattempted dependency-controlled step uses `status="blocked"`, `error_code=null`, and
`blocked_by` equal to the earliest failed direct or transitive prerequisite in
`DISCONNECT_STEP_ORDER_V1`. An actually attempted failure uses `status="failed"`, non-null
`error_code`, and `blocked_by=null`. `completed`, `scheduled`, `not_requested`, and `not_applicable`
always have `error_code=null` and `blocked_by=null`. A step whose request parameter is false remains
`not_requested` even when an earlier barrier fails. No mandatory step may be reported `completed`
from intent alone.

The `close_browser` step is `completed` only when that dedicated NAB-owned process was closed,
`failed` when such a requested close failed, and `not_requested` when deletion was not requested.
`delete_dedicated_profile` is `scheduled` only after the validated
job was installed and the required close completed; otherwise it is `not_requested`, `blocked`, or
`failed` according to the table. Provider logout never implies
browser closure or confirmed server-session revocation.

Every mandatory local step reports `completed` only after its durable absence/commit proof and
otherwise is `failed` when attempted or `blocked` when its prerequisite failed; it has no
`not_requested` branch. `remove_browser_permissions` is
`not_requested` iff its parameter is false, and `provider_logout` is `not_requested` iff
`sign_out_dedicated_profile` is false. When that flag is true, only a definite success under the
accepted executable asset is `completed`; missing/non-executable asset or any action ambiguity is
`failed` with the fixed mapped code, never guessed navigation and never `not_requested`.
`teardown_browser_mode` is `completed` only after the page observer or browser-catalog registration,
documents, and closure are all proved absent under the marker; it is `not_applicable` exactly for
native-replay's null/null cleanup variant and `failed` otherwise. A teardown failure retains the
cleanup marker, makes subsequent no-grant status report `pending_browser_cleanup=true`, and cannot be
hidden by `remove_browser_permissions=not_requested` or by successful local authority revocation.
`install_profile_deletion_job`, `close_browser`, and `delete_dedicated_profile` are `not_requested`
iff the deletion parameter is false or the profile is not dedicated. For a requested deletion, job
registration is `completed`, close is `completed`, and deletion is `scheduled`; a prerequisite
failure makes the attempted step `failed` and every dependent unperformed step `blocked`, never
`not_requested`.
`provider_session_revocation = "not_requested"` exactly when logout was not requested;
`"confirmed"` requires a signed non-null `session_revocation_contract` and its exact server-side
proof. Ordinary logout/navigation is only `"not_confirmed"`, as is any requested failure.

`DisconnectResultV1.steps` contains exactly one entry for every `DisconnectStepV1` in the report
order fixed by `DISCONNECT_STEP_ORDER_V1`, with no duplicates. Report order is independent of the
execution chronology above and cannot be changed by an implementation. `error_code` is non-null if
and only if `status = "failed"`; `blocked_by` is non-null if and only if `status = "blocked"`.
`local_authority_revoked` is true if and only if the fixed pairing item is absent,
`active_pairing`, `pairing_transition`, `pairing_retirement`, and `replay_state` are null, the old
replay key/file and every grant authority object are absent, and the consent,
grant-record key, binding, identity/reference keys, normalized cache/cursors, and native credential
are absent, their deletion intents are durably complete, and the broker refuses every later call;
browser-permission/logout/profile-job failure is reported separately and does not make that boolean
false. The installation-scoped manifest/state-seal/rate keys and nonsecret rate history may remain as
section 4.7 requires and are not local provider authority.

The profile-deletion job is created before key deletion as an explicit absolute target previously
recorded as an NAB-owned dedicated profile (never a default profile, home directory, variable, or
symlink). Its exact AEAD record, sealed key handoff, installation transaction, process-start check, and
single-use behavior are section 4.7.6. It waits for that exact Chrome process to exit, revalidates the
target, and deletes only that directory. The helper never deletes the envelope; after independently
proving deletion, the broker clears the protected retired-profile link and deletes the envelope.
Failure leaves the remaining
profile/quarantine subtree and retired-profile record intact and
is not retrospectively reported as completed.

### 13.1 Trusted cleanup after expiry or partial disconnect

Retained cleanup state has a reachable broker-owned foreground flow, `nab web cleanup`, but it is
not a `BrokerOperationV1`, agent tool, or unattended CLI request. The signed broker opens its own
trusted OS window, reads the sole authenticated tombstone/marker/retired-profile tuple, and displays
the opaque `plan_ref`, exact dedicated-profile path, pending browser actions, inability to guarantee
server logout, and the proposed deletion. A one-use 60-second user-presence approval is bound to the
authority-index generation, marker/job IDs, profile/parent/directory/process identities, and action
`delete_dedicated_profile`; no token crosses IPC.

Under the installation lock it requires no active grant, candidate, preparation, scheduler, or data/
capture host. It first attempts an existing cleanup marker through the cleanup-only Native channel
when the exact pinned profile/extension is still available. A true marker-only state, such as a
disconnect where profile deletion was not requested, ends after the authenticated cleanup ack proves
every named observer/realm/capture-listener/permission postcondition and the broker atomically clears
that marker; it must not invent a deletion target or job. `capture_completion` is never marker-only:
its matching `capture_cleanup_pending` retired-profile record preserves the logged-in dedicated
profile's safe ownership/deletion path. If and only if a matching `retired_profile` exists, the flow
then creates or resumes exactly the authenticated job in section 4.7.6, commits
`prepared`, registers/verifies it, commits `registered`, and closes only the saved NAB-launched
Chrome process. The helper performs deletion after exit. The broker later independently proves both
original and quarantine identities absent, clears the retired-profile record, clears any remaining
marker on the profile-deletion-proof branch above, and deletes the envelope. The expired tombstone
remains until its normal retention/explicit removal rule. If the job is already `prepared` or
`registered`, this flow can only resume that exact job; it cannot generate a new path or target. Any
mismatch, missing proof, partial deletion, or registration ambiguity remains durable and requires
the same trusted retry or explicit uninstall/manual profile-handling path; Version 1 never
reconstructs lost authenticated cleanup state.

The trusted window reports only `browser_cleanup` as `completed`, `satisfied_by_profile_deletion`,
or `pending`; `profile_deletion` as `scheduled`, `completed`, or `failed`; and
`provider_session_revocation` as `not_requested` or `not_confirmed`. It never reports `confirmed`
without the executable revocation proof from section 4.4. Closing the window does not cancel a
registered one-shot job. This is the only Version 1 route that can schedule deletion from an expired
or otherwise no-live-grant `retired_profile` record.

Deleting a copied credential does not revoke copies already exfiltrated and may not invalidate the
server session. Raw-export UX must say so. If reliable provider-side session revocation cannot be
demonstrated, the product must not claim complete revocation for `native-replay`.

## 14. Conformance requirements

A release candidate MUST pass every applicable category below. This is the closed Version 1
category inventory; the provider policy's signed conformance manifest supplies concrete positive/
negative vectors for the selected build and mode. Missing vectors, an unimplemented transition, or
a newly discovered state/field/dependency is a release failure rather than permission to infer a
default.

1. **Lexical and canonical data:** UTF-8, scalar-value strings, escaped-name duplicate keys, every
   JSON number class, safe money/knowledge integers, negative zero, depth/count/string/byte ceilings,
   RFC 8785 vectors, base64url grammar, UUID/time/date grammar, and cross-language SHA-256/Ed25519/
   HMAC/AEAD vectors.
2. **Provider policy and asset closure:** signature-omitted policy preimage, full-policy
   `provider_policy_sha256` preimage, pinned root key, version/expiry/rollback, exact asset
   ID-kind-path-target/hash/size/JCS closure, duplicate/unknown asset rejection, response-shape and
   per-field disposition coverage, matched-shape/logout/rate/build assets, and no network fallback
   or stale-policy rescue.
3. **Installation root:** first-install metadata/key creation, exact credential item names and
   access controls, manifest binding to metadata, publisher/product/browser/executable/path
   mismatch, missing/corrupt/oversized metadata, no in-place identity update, startup ordering, and
   uninstall-only recovery with metadata deletion last.
4. **Authenticated authority state:** all legal and illegal combinations of active grant,
   candidate, preparation, capture-cleanup intent, tombstone, cleanup marker, retired profile,
   scheduler, reservation, credential pointer, and manifest generation; exact one-writer lock
   behavior; fixed credential
   lookup; pairing-key creation/rotation/retirement; and rejection of orphaned or cross-installation
   files/credential items.
5. **Crash consistency:** deterministic fault injection immediately before and after every durable
   file/manifest/keychain/OS-job/network-dispatch/Native-message transition specified in sections
   4 and 7–13, including fsync/rename and response-flush boundaries. Restart must reach the exact
   specified resumable state or quarantine; it may never duplicate authority, shorten a deadline,
   expose a staged credential, advance a cursor early, or invent authenticated repair state.
6. **Consent and profile identity:** dedicated-profile creation and proof, signed browser product
   identity, exact extension/host/broker identity, user-presence expiry, one-time versus standing
   grants, plan/account fingerprint binding, capability/mode changes, candidate promotion,
   renewal/retirement, consent expiry, re-consent, and denial/close/navigation at every ceremony
   step.
7. **Chrome permission lifecycle:** exact precommitted permission sets per mode; request only after
   the gesture; partial grant/denial; `permissions.contains` races; dynamic registration identity;
   preparation-to-active transfer; rollback; expiry; one-shot capture intent/retirement; disconnect;
   popup gesture-port lifecycle; open-prompt crash races; permission-event drain; observer/realm hard
   teardown; marker-plus-retired-profile capture cleanup; and proof that cleanup removes no
   permission outside the saved obligation.
8. **CLI/broker IPC:** Unix socket/named-pipe ownership and peer identity, concurrent clients,
   canonical HMAC request/response vectors, constant-time tag checks, nonce replay and bounded cache,
   issuance/expiry/clock skew, unknown/duplicate fields, operation-specific parameter closure,
   response authentication before display, disconnect/no-live-cleanup branches, and every 0/max/
   max+1/truncated/extra-byte boundary.
9. **Native Messaging:** native-endian 32-bit framing, 0/1 MiB/64 MiB boundaries in the correct
   direction, origin argv and pinned extension identity, process/port cardinality, hello/bind/
   permit sequencing, request/receipt correlation, worker suspension, port replacement, late or
   duplicated messages, and the rule that content scripts never talk directly to the native host.
10. **Scheduler and rate state:** boot-ID and wall/monotonic-clock transitions, rollback/forward
    clock quarantine, burst and rolling-window boundaries, reservation create/commit/cancel/crash,
    concurrent attempts, provider `Retry-After` parsing/caps, cadence, provider-error quarantine,
    exact maximum-of-deadlines invariant, and proof that reconnect, re-consent, pairing, profile
    recreation, failure, restart, or disconnect cannot shorten any installation-wide deadline.
11. **Page-snapshot mode:** exact document/build/accessor/payload/passive-success assets; top-frame
    origin and `documentId` lifecycle; registration/navigation/prerender/BFCache races; pre/post
    sync and dirty-state invariants; complete account/payee/transaction/subtransaction indexes;
    dangling/tombstoned links; payee-based and direct transfer linkage; live splits; reciprocal
    match graphs; projection-before-filter count/byte ceilings; hostile MAIN-world values,
    prototypes/getters/proxies/callbacks; and teardown after success, failure, timeout, or port loss.
12. **Browser-catalog mode:** provider-managed realm and running-build attestation, session/Castle/
    device/token-channel bootstrap, exact origin/path/method/form/operation/header closure,
    redirect/content-type/size limits, recursively empty changes and zero bounds, bootstrap/
    backfill/delta order, identity proofs, whole-response candidate merge, tombstones, entity-before-
    cursor publication, response-registry collection and per-field decisions, version changes,
    cursor regression, malformed success, and every exact `(operation, HTTP status, error form,
    known ID)` decoder branch. Success vectors MUST use HTTP 200–299; all other status values fail.
13. **Stateful credential rotation:** session token and Castle state staged as one candidate,
    dispatch-uncertain outcomes, acknowledged/committed/aborted two-phase transitions, duplicate and
    out-of-order acknowledgements, crash at each boundary, old/new ambiguity quarantine, help-token
    disposal, and proof that no ordinary sync/reconnect clears provider or ambiguity quarantine.
14. **V1 native-capture research:** exact arming/active epochs, sentinel-first observer installation,
    popup gesture-start/settlement proof, quiescence and overlap rejection, cookie store/partition/
    permission-scope/domain/path/Secure/expiry rules, three phase-bound cookie snapshot commitments,
    overwrite/remove races, capture challenge/outcome/stage-ack/decision/receipt ordering,
    staged decision context and `decision_before` enforcement, timeout/crash/denial zeroization, and proof that every seed is
    validate-and-erase only—never persisted, dispatched, or returned as a pending result.
15. **Normalization and query semantics:** every supported pending source, `accepted`/`cleared`
    orthogonality, absent versus null payee, selected-account authorization, transfer/split rejection,
    matched visible/hidden single-counting, imported-pending opt-in, tombstones/disappearance,
    private reference/account aliases, fixed null public IDs/capabilities, milliunit/date/Unicode
    boundaries, filtering after complete projection, `list`/`get` equivalence, cache freshness, and
    deterministic sort/output bytes.
16. **Errors and status:** every broker error code with fixed retryability/`retry_after_ms`, exact
    application-error lexical decoder and context table, HTTP/network/login/challenge/malformed JSON/
    oversize/version/identity mappings, `session.status` discriminants and cleanup flag, redacted
    diagnostics, no stale-success fallback, and no known error ID accepted in the wrong operation or
    status context.
17. **Disconnect, expiry, and cleanup:** active and no-live-grant disconnect, response-flush ordering,
    local authority revocation, provider logout/revocation proof, cleanup-only channel isolation,
    optional permission removal, observer/realm teardown, exact profile ownership, AEAD/HMAC cleanup
    envelope, OS job registration/reconciliation, process identity, quarantine rename/delete,
    partial deletion and retry, trusted `nab web cleanup`, uninstall, and the invariant that local
    deletion/profile deletion never claims provider-session revocation.
18. **Information-flow security:** secret canaries through stdout/stderr/logs/traces/exceptions/
    crash reports/telemetry/argv/environment/clipboard/temp files/agent and plugin responses;
    financial-data canaries; credential-store access denial to CLI/agent processes; bounded audit
    fields; and memory-lifetime/zeroization tests for every mutable secret buffer.
19. **Adversarial/property testing:** generated requests, page values, responses, entity graphs,
    registry assets, state files, and interleavings proving that no caller can select an arbitrary
    URL, host, method, redirect, operation, header, cookie, JavaScript source, schema, diagnostic
    sink, credential item, profile path, or nonempty catalog change set; and that transaction text
    can never be interpreted as an instruction.
20. **Mode capability matrix:** each mode is tested both with all signed gates satisfied and with
    each gate individually absent, expired, mismatched, or changed. Page and browser-catalog success
    are possible only in their own fully attested matrices; `native-replay` Version 1 has no success
    matrix for `pending.list`/`pending.get` and MUST always remain dispatch-disabled.

## 15. Immediate no-go conditions

- No written provider permission for the selected mode.
- Need to use or scrape the user's normal Chrome profile database.
- Need for `<all_urls>`, `debugger`, arbitrary fetch/eval, or a listening debug port.
- Any private write or nonempty change set.
- Any credential can reach an agent/model/plugin, ordinary NAB output, or a process outside the
  attested browser/extension/Native-host/broker trust boundary.
- Castle/security challenge would have to be bypassed or synthesized.
- Plan identity cannot be positively bound.
- Schema/version circuit breaker is disabled.
- Copied-session revocation limitations are not clearly disclosed.

## 16. Platform references

- Chrome cookies API: <https://developer.chrome.com/docs/extensions/reference/api/cookies>
- Chrome permissions API: <https://developer.chrome.com/docs/extensions/reference/api/permissions>
- Chrome content-script worlds: <https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts>
- Chrome Native Messaging: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Chrome extension security: <https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure>
- Chromium user data directories: <https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md>
- RFC 8785 JSON Canonicalization Scheme: <https://www.rfc-editor.org/rfc/rfc8785>
- Apple data-protection Keychain guidance: <https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains>
