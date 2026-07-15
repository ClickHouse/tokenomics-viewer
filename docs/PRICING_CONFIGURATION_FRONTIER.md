# Pricing and Configuration Frontier SDD

Document status: admitted implementation
Current frontier: database-backed analytics configuration and pricing catalog
Bounded context: pricing, derived cost persistence, dashboard configuration, and future session access

## Problem

Project cost totals are computed correctly from event-level model prices, but the
dashboard does not expose model composition, tariff coverage, or cache-write vs
cache-read cost. Pricing is packaged in JavaScript, so edits require a deploy and
manual derivation-version discipline.

## Admitted Surface

- SQLite and ClickHouse store the active analytics settings and structured
  pricing rows in backend-owned tables.
- A packaged catalog seeds an empty database. Once seeded, the database copy is
  authoritative for database-backed sync and report operations.
- Direct scans without a database continue to use the packaged catalog.
- Configuration reads return a revision. Writes require that revision and
  replace settings and prices atomically from the API consumer's perspective.
- Configuration mutation is loopback-only and requires the same-origin custom
  action header used by Sync.
- The local webserver serializes configuration writes against Sync. Either
  conflicting operation receives `409` before it can cross the other's commit
  boundary.
- Source fingerprints exclude pricing revisions. Price changes operate only on
  normalized database rows and never reread unchanged source bytes.
- A successful configuration write makes repriced reports immediately visible.
  SQLite derives event costs from the active catalog while reading normalized
  rows. ClickHouse writes revisioned cost overlays and publishes the configuration
  marker only after both usage and rate-limit overlays are complete.
- Project summaries expose tariff coverage and per-model aggregates.
- Project cost UI identifies its basis as an API-equivalent estimate, shows
  unpriced coverage, and separates cache read from cache creation in detail
  while preserving the primary In / Cache / Out visual hierarchy.
- Supported mutable analytics settings are `openaiContext`, `pricingBasis`, and
  `regionalMultiplier`. Unknown settings are rejected rather than silently
  accepted.
- Provider slugs and model ids are extensible catalog data. A custom row prices
  only source events that already carry the matching provider identity.

## Rejected Surface

- Database ownership of connection/bootstrap settings: database engine, URL,
  database name, credentials, bind host/port, and source paths remain CLI/env
  inputs because they are required before configuration can be read.
- Treating API-equivalent estimates as provider invoices or subscription spend.
- Repricing by rescanning JSONL, ZIP, or Zstandard session sources.
- Publishing a ClickHouse configuration marker before its cost overlays are
  complete.
- Unauthenticated or non-loopback configuration writes.
- Editing provider credentials or arbitrary SQL through the dashboard.
- Deleting the final usable pricing catalog without an explicit reset path.

## Guard-Only Future: Compressed Session Store and Viewer

- A future `session_blobs` surface may store the canonical session payload as
  Zstandard-compressed bytes plus content hash, uncompressed size, codec/version,
  source identity, project, session id, parent session id, and timestamps.
- Blob visibility must follow the same committed-generation manifest as derived
  usage rows; a failed sync cannot expose a blob without its matching metadata.
- Deduplication is content-addressed. Shared inherited transcript prefixes are
  not expanded into multiple logical sessions merely because bytes repeat.
- A future project-scoped session viewer may list metadata first and fetch one
  bounded/decompressed session on demand. It must not load all session bodies,
  expose arbitrary filesystem paths, or return unbounded payloads.
- Viewer records must distinguish original log records from derived annotations
  and must preserve parent/child provenance.
- This surface is guard-only: this slice adds no session blob table, ingestion,
  decompression endpoint, or viewer UI.

## Design Laws

1. Price each usage event with its provider, model, timestamp, context variant,
   and active catalog row before aggregation.
2. Aggregate dollar buckets; never reprice mixed-model token totals with an
   average model rate.
3. Token totals include all recognized usage. Dollar totals include only priced
   usage and must display tariff coverage alongside them.
4. Cache total equals cache creation plus cache read; the detailed breakdown must
   remain available because their rates and optimization actions differ.
5. Configuration revisions are optimistic-concurrency and cost-visibility
   tokens, not source-derivation inputs or cosmetic timestamps.
6. Invalid, ambiguous, overlapping, or negative pricing rows fail closed.
7. Backend parity is behavioral: SQLite and ClickHouse return the same normalized
   configuration and both reprice without invalidating source fingerprints.

## Execution Order

1. Ensure backend schema and seed defaults only when no active configuration
   revision exists.
2. Fingerprint sources using source metadata and analytics derivation only.
3. Price newly imported usage events using the active immutable configuration.
4. Publish the report only after the backend's existing sync commit boundary.
5. On configuration write, validate and stage the new revision using optimistic
   concurrency.
6. Reprice normalized database rows without opening source files. In ClickHouse,
   write usage and rate-limit cost overlays before the revision marker.
7. Replace the in-process report cache after repricing; no Sync is required.

## Falsifier Roster

- Mixed-model project: event-level costs equal the sum of each model's rates.
- Partially unpriced project: token totals remain complete, cost is explicitly
  labeled partial, and coverage is visible.
- Cache creation/read: combined cache cost equals its components and the UI shows
  both components without changing the three-series chart.
- Stale writer: a write using an old revision returns conflict and changes no
  active configuration.
- Invalid catalog: negative prices, malformed provider slugs, overlapping rows,
  invalid context variants, unsupported basis labels, and an empty catalog are
  rejected.
- Configuration change: report costs change immediately, source fingerprints and
  import timestamps remain unchanged, and the next Sync reports no changed source.
- Legacy fingerprint: obsolete pricing fields are ignored without causing a
  one-time full reimport.
- ClickHouse publication failure: a missing overlay or failed repricing query
  leaves the previous configuration revision visible.
- Backend parity: seeded and edited configuration round-trips identically through
  SQLite and ClickHouse.
- Remote binding or missing action header: configuration mutation is rejected.
- Existing database migration: analytics rows remain readable and a default
  configuration is seeded exactly once.

## Stop Rules

- Do not claim billing accuracy without service-tier, region, and provider invoice
  evidence.
- Do not expose mutable configuration until revision conflict, body-size,
  validation, and loopback guards pass.
- Do not admit session body storage until generation visibility, decompression
  bounds, deduplication, and project authorization falsifiers exist.

## Implementation Seals

- Slice: database-backed pricing/settings and project cost transparency
- Source/spec: `lib/core/configuration.js`, `lib/core/pricing.js`,
  `lib/storage/`, `lib/web-server.js`, `lib/dashboard.js`, `public/index.html`
- Falsifiers: `test/configuration.test.js`, storage tests, web tests, dashboard
  report tests, and mixed-model pricing tests
- Boundary: local single-user dashboard; SQLite and ClickHouse parity; Standard
  API-equivalent basis unless an admitted multiplier is configured
- Evidence: configuration, pricing, dashboard, SQLite, ClickHouse, derivation,
  and web API falsifiers in `test/*.test.js`; final full-suite and browser
  evidence recorded in the implementation commit
- Next local track: guard-only compressed session storage and project session
  viewer
