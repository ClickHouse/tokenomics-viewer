# ClickHouse Import Visibility Frontier

Document status: admitted
Current frontier: sync-wide committed manifests with pinned report reads
Bounded context: ClickHouse sync and report reads

## Admitted Surface

- Every source-owned row carries an immutable source-version `import_id`.
- Every committed sync has a `generation_id` and a complete manifest mapping
  every visible `source_path` to one `import_id`.
- A sync becomes visible only after all changed-source rows, changed-source
  Codex headers, and the complete manifest are written, followed by one global
  marker in `import_generations`.
- A failed multi-source import leaves the entire previous generation visible.
- A report pins one `generation_id` before its first query and uses that same
  manifest for every aggregation query.
- Report bucket aggregation stays in ClickHouse. Usage buckets share one
  `GROUPING SETS` pass over the pinned generation, and rate-limit window plus
  attribution buckets share one ordered-window pass.
- Retrying an import may leave physically stale rows, but committed reports
  ignore rows not referenced by their pinned manifest.
- Existing databases migrate in place. Legacy completion markers bootstrap one
  baseline manifest whose rows use the empty `import_id`; unmarked partial rows
  remain unreachable.

## Rejected Surface

- Delete-before-insert replacement.
- Visibility based on eventual `ReplacingMergeTree` merges or `FINAL`.
- Reconstructing cross-bucket usage or rate-limit aggregates in Node.js.
- Multiple concurrent sync writers for the same database.
- Automatic removal of disappeared sources during a partial or explicit-path
  sync; source ownership and authoritative-root semantics are not yet defined.

## Guard-Only Future

- Garbage collection of superseded and abandoned generations. Stale physical
  rows are permitted because pinned manifests do not reference them.
- Writer conflict detection or a lease if concurrent writers become supported.
- Persistent `AggregatingMergeTree` report caches. A safe cache must be keyed
  by both `generation_id` and `pricing_revision`, become visible marker-last,
  and fall back to the pinned raw query when incomplete.

## Design Laws

1. Data and complete manifest first, global marker last.
2. Readers join source-owned tables to the pinned manifest by
   `(generation_id, source_path, import_id)`.
3. An unchanged fingerprint performs no writes or cleanup.
4. Schema migration must preserve visibility of legacy rows.
5. Source replacement must not depend on ClickHouse mutation completion.
6. No correctness-sensitive write occurs after the global marker.
7. Query acceleration must preserve the pinned generation and active pricing
   revision; physical part replacement is not a report visibility protocol.

## Execution Order

1. Pin the latest committed generation and load its complete source manifest.
2. Allocate a new `import_id` for each changed source and stream its rows.
3. Write changed-source Codex headers under their new import ids.
4. Write a new complete manifest, carrying forward unchanged source mappings.
5. Append one global `generation_id` marker last.
6. Rebuild the report with that generation pinned across all queries.

## Falsifier Roster

- Source B fails after source A staged successfully: the old report remains
  visible for both sources and no global marker exists.
- Retry after a partial failure: only the retried generation is visible and
  totals are not duplicated.
- Successful replacement: report switches from the old complete totals to the
  new complete totals only after the global marker insertion.
- Unchanged source: no source-owned insert or mutation occurs.
- Legacy schema: `ADD COLUMN IF NOT EXISTS` plus an empty-`import_id` baseline
  manifest preserves completion-marked existing rows.
- A report pins generation G0, G1 commits between report queries, and every
  remaining query still uses G0.
- Source-shape guard: every report and fork-header query joins the explicitly
  pinned manifest; dynamic latest-generation views are not correctness seals.
- Aggregate-shape guard: all usage bucket families come from one grouping-set
  query, and rate-limit base plus attribution rows come from one window query.
- Aggregate parity: optimized reports preserve every map key and all integer
  counters; floating costs may differ only by normal summation-order rounding.

## Stop Rules

- Do not claim transactional replacement if any read path lacks the same pinned
  generation parameter or if any correctness-sensitive write follows commit.
- Do not widen to concurrent writers without a report snapshot protocol and a
  writer-conflict falsifier.

## Implementation Seals

- Slice: sync-wide manifest commits and adversarial ZIP parsing
- Source/spec: `lib/storage/clickhouse.js`, `lib/ingest/archive.js`
- Falsifiers: `test/clickhouse.test.js`, `test/archive.test.js`
- Boundary: single sync writer; dependency-free ZIP reader
- Evidence: 87 Node tests pass; focused failure tests cover multi-source abort,
  failed-first-sync retry, explicit migration column order, marker ordering,
  generation pinning, ZIP entry removal, and malformed ZIP structures.
- Coverage: 88.80% lines, 79.79% branches, and 85.28% functions overall;
  `archive.js` is 88.34% lines and `clickhouse.js` is 85.21% lines.
- Evidence: ClickHouse 26.7 fresh-schema, in-place legacy migration, unchanged
  retry, HTTP dashboard, and production control-slice probes pass.
- Control slice: Adamas 2026-07-09 remains 3,026 requests, 7,449,816 input,
  573,923,327 cache-read, 1,271,154 output, and $441.0378985.
- Report aggregation slice: on 4,523,788 usage rows, the usage query dropped
  from 11.3s to 2.0s and the two rate-limit passes dropped from 17.2s total to
  one 5.1s pass. A full 2,877,549-number report comparison found no difference
  above `1e-12` relative tolerance; maximum observed drift was `7.61e-14`.
