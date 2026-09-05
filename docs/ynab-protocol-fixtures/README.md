# Synthetic `pending-read-v1` fixtures

This directory is the schema-checkable synthetic algorithm seed corpus for the private catalog reader and normalized
bridge contract. It contains no captured credentials, identifiers, financial records, merchant
text, or browser data. Every `syn:*` value and the fixed key in `manifest.json` are invented test
vectors. A harness MUST refuse to send any fixture to a network endpoint.

The matched-pending positive vector encodes the proposed fail-closed V1 shape. It is a normalizer
conformance test, not runtime evidence that YNAB currently emits that exact winner/loser form; the
signed matched-shape gate remains required.

## Layout

- Provider request/response fixtures are at the directory root. They represent decoded JSON; they
  do not include HTTP framing.
- `expected/` contains complete normalized `PendingListResultV1` golden values.
- `schemas/` contains closed JSON Schema Draft 2020-12 schemas for the manifest, normalized pending
  transaction, normalized list, and CLI-to-broker request.
- `manifest.json` is the deterministic algorithm-case graph and the only source of operation, sync type, setup,
  expected phase/commit/error/output tuple, and exact post-state association.

For a provider fixture, the enclosing HTTP form would be:

```text
operation_name=<manifest operation>
request_data=RFC8785_JCS(<request fixture>)
```

Those two values are serialized in that order with the WHATWG form serializer; plain
`JSON.stringify` is not the normative request serializer.

The manifest execution model is
`reset_then_inject_provider_context_then_apply_setup_in_order`: for every case, start with a new
logical device and empty cache, inject `provider_contract_context` before decoding the first setup
response, apply each response named in `setup` in order with its operation and sync type from its own
manifest case, and then evaluate `fixture_file`. Identity fingerprints are therefore available
before initial/catalog authorization and the two synthetic contract assumptions are available before
response decoding or match-graph validation. Cases are isolated; lexical filename order is never an
implicit test sequence. Only after a response has been accepted/materialized does the harness inject
`normalization_context` for query output. Its separate synthetic reference key is used with the exact
length-prefixed HMAC derivation in the bridge specification, which makes opaque references
reproducible without treating a raw private ID as a public ID or reusing the identity key.

`expected.phase` names the furthest contract boundary asserted by the case, not merely the boundary
at which state last changed:

- `initial_decode` validates and identity-binds the initial response, then performs the atomic
  session/user/zero-catalog commit;
- `request_guard` validates the final serialized outbound operation before permit acquisition or
  transport;
- `response_decode` validates the transport/application envelope, versions, cursors, and lexical
  response shape before candidate merge;
- `merge` constructs and validates the complete candidate entity graph and asserts the stated
  atomic commit or non-commit result; and
- `normalize` runs the pending query over committed materialized state and compares either the
  complete golden output or the complete query error.

Consequently, a successful no-change delta with a golden list has phase `normalize` even though its
only state mutation is the cursor commit. Every non-null `normalized_output_file` and every
`accept_then_query_error` case has phase `normalize`.

`state_oracles` is a normalized, exact state-oracle registry. Resolve a case's
`expected.post_state_oracle` in `state_oracles.post_states`, then resolve its four references in the
corresponding device/catalog/family/budget registries. Missing, extra, wrong-kind, or multiply
resolved names fail the case. The resolved projection is compared field-for-field after the case's
mandatory lifecycle transition. It fixes device lifecycle/workflow/session/cache/reusability; each
document's schema knowledge and exact `Kc`, `Ks`, and `Kr`; bound identity and budget range; and the
sorted, disjoint active/tombstone ID sets for every V1-materialized collection. There are no implied
defaults. A `purged` device must resolve all documents to their explicit `not_initialized` states;
the separate `commit` assertion still proves whether a candidate committed before terminal
teardown (as in a query-time protocol failure) or never committed.

Each catalog, family, and budget oracle is also a status-discriminated state, not an independently
typed bag of fields. The manifest schema enforces the normative null/zero/non-null knowledge and
identity combinations plus collection cardinalities for every status. Family identity always
includes `unavailable_reason`: it is null for uninitialized, sync-pending, absent, and available;
`permission_error` requires unavailable status, zero knowledge, and an entirely empty family
cache; `matching_family_tombstone` requires unavailable status, checkpointed knowledge, no active
family/member rows, and exactly one family tombstone (retained member tombstones are allowed).
Budget range is an atomic null/null or full-date/full-date pair in every status. The schema cannot
compare values across properties, so the semantic validator MUST additionally require the active
catalog user ID to equal `bound_user_id`, the available family singleton or unavailable family
tombstone ID to equal `family_id`, the active budget singleton ID to equal `budget_version_id`, and
any non-null date pair to satisfy `first_month <= last_month`.

`provider_contract_context.synthetic_algorithm_assumptions` are mock harness preconditions, not
canonical schema bytes, hashes, signed provider assets, or evidence that the present private client
can run. They let the corpus exercise proposed decode/match algorithms only. This directory by
itself cannot validate the production response-shape registry, provider status/error contract, or
matched-shape asset and MUST NOT be cited as executable private-protocol conformance or copied into a
runtime policy.

`disposition = accept_then_query_error` is deliberate. A well-formed provider delta containing a
pending transfer or live split child may be atomically materialized and checkpointed, but the
subsequent version-1 pending query MUST fail as a whole with `UNSUPPORTED_PENDING_SHAPE`; it must not
truncate, flatten, or double-count the record. A non-null dangling payee is likewise materialized
and checkpointed before resolution by the query, but returns `PROTOCOL_CHANGED` and triggers the
terminal teardown encoded by its state oracle. `reject_without_commit` instead means neither entity
state nor the cursor changes. `reject_before_transport` means no provider dispatch occurred. The
manifest-v2 schema admits no unexercised "reserved" disposition. The empty-catalog case is an
authorization-negative: because the complete candidate lacks the consent-bound relation, it is
rejected before merge/cursor commit with `PERMISSION_DENIED`. A broken match graph likewise rejects
the whole candidate before commit with `PROTOCOL_CHANGED`; transfer/split/dangling-payee projection
failures deliberately use the different accept-then-query-error path.

The initial-response case commits the returned session token, bound user, and zero catalog state
only after recomputing the synthetic account fingerprint from `identity_key_hex`; it is not a
token-only commit. The authorized catalog case similarly verifies the synthetic budget and
budget-version fingerprints before it becomes selectable. The nonempty request guard returns
`AMBIGUOUS_COMMIT` and permanently discards the logical device even though this fixture proves the
guard stopped transport; that code represents an internal write-invariant breach, not evidence that
the server committed anything.

The nonempty outbound request fixture contains a complete, otherwise structurally valid transaction
group. A conforming implementation therefore rejects it specifically because
`changed_entities` is not the exact empty object—not because its transaction member is malformed.

## Harness requirements

- Parse every JSON document with duplicate-key detection before schema validation or numeric
  conversion. `jq` validates syntax only and does not detect duplicate keys.
- Assert JSON Schema `format` values (`date`, `date-time`, and `uuid`); do not treat them as
  annotations.
- Validate integer lexemes and safe-range constraints using the token-aware rules in the catalog
  protocol before conversion to a JavaScript number.
- Apply the exact API/schema versions in the parent specification.
- Treat `server_knowledge_of_device = 0` as mandatory for this fresh no-financial-mutation device.
- Commit complete entity replacements and tombstones before `device_knowledge_of_server`; bootstrap
  never checkpoints the budget cursor.
- Never copy a response object or response collection into an outbound change set.
- Recompute every expected private reference from `normalization_context.reference_key_hex`; do not
  simply trust the golden alias.
- Require `provider_contract_context.identity_key_hex` and
  `normalization_context.reference_key_hex` to decode to distinct 32-byte keys; a swap must fail the
  corresponding fingerprint/reference vectors.
- Require unique case IDs and primary fixture paths, reject absolute or parent-directory paths,
  require every setup path to name exactly one response case, and reject setup cycles or a case that
  names its own primary fixture. These graph/path rules are semantic checks beyond the manifest
  schema's per-object validation.
- Require every case oracle name and every post-state component reference to resolve to exactly one
  entry in its designated registry. Require every registry entry to be referenced, compare the
  fully resolved post-state projection exactly, sort entity IDs by raw UTF-8 bytes, and reject an ID
  present in both active and tombstone sets of the same collection. Enforce the cross-property
  identity equalities for selected/available/unavailable/ready states described above; JSON Schema
  establishes the status branch and cardinality but cannot establish that two string values are
  equal.
- Validate all golden lists with `schemas/pending-list-v1.schema.json`, resolving its relative
  transaction-schema reference.
- Enforce the semantic checks that JSON Schema cannot express: UTF-8 byte ceilings, Unicode scalar
  validity, unique private references, deterministic record ordering, record/snapshot
  `observed_at` equality, minimum/maximum materialized dates, first-date <= last-date, JCS result
  size, request timestamp ordering, HMAC validity, nonce replay, and `since_date <= until_date`.
- Redact the synthetic session token anyway; redaction is based on field classification, not on
  whether a value looks real.

Version 1 has no private/public identity join. Every normalized public transaction/account ID is
exactly `null`, `public_get` and `public_update` are exactly `false`, and every nonempty list carries
the single `UNMAPPED_ACCOUNT` warning. A future provider-defined join requires a different schema
and profile; tests for a mapping-present or mapping-ambiguous branch do not belong in this corpus.

## Local syntax check

From the repository root:

```sh
find docs/ynab-protocol-fixtures -name '*.json' -print0 |
  xargs -0 -n1 jq empty
```

That command proves only that every file is valid JSON. A conforming runner must also use a Draft
2020-12 validator with `date`, `date-time`, and `uuid` format assertions to validate the manifest
against `schemas/fixture-manifest-v2.schema.json`, validate the golden outputs against the normalized
schemas, reject duplicate keys before either step, and enforce all protocol semantics listed above.

## Coverage boundary

The checked-in cases cover token replacement, an empty-catalog authorization-negative and an
authorized catalog relation, family materialization, bootstrap without checkpoint, empty and
raw-pending backfill, matched-pair deduplication, absent-payee normalization, no-change delta,
tombstone application, exact-empty outbound guarding, schema and application-error rejection,
broken-match pre-commit rejection, dangling-payee protocol failure, plus transfer/split fail-closed
query behavior. Every case now has an exact post-state oracle.

The normative matrix in `YNAB_CATALOG_PROTOCOL.md` is larger than this seed corpus. A production
implementation still needs generated/property tests for family absence and permission denial,
unknown optional fields/collections, unsafe/noninteger/regressing cursors, invalid amount/date/source
or cleared values, duplicate IDs, additional broken-match permutations, HTML/login/challenge
bodies, cumulative entity/byte limits, crash points, authenticated broker responses, and every
replay/time/HMAC boundary. In particular, there is no checked-in seed for source `Pending`, source
`ImportedPending`, the accepted/cleared orthogonality cross-product, the
`include_entered_provisional` false/true opt-in boundary, `pending.get`, the account filter, or the
inclusive since/until date filters (including filter intersections and boundary dates). Explicit-null
payee equivalence and family absence are also matrix requirements without checked-in seeds. Missing
seed files do not relax those normative requirements.
