# Requirements: Add omp (oh-my-pi) support

> **Status:** Grill COMPLETE — all six decision branches resolved (2026-07-22).
> This document captures *what* must be built, not *how*. The exact omp log
> format/path is deferred to research (DrPe) and listed under Open Items.

## Overview

`tokenomics-viewer` currently supports two AI coding-agent platforms — **Claude Code** and **Codex** (OpenAI Codex CLI) — across ingest parsing, core logic, storage, CLI flags, dashboard UI, pricing config, and tests. This work adds a third first-class platform: **omp (oh-my-pi)**. omp is treated as a top-level platform peer that **emits its own consolidated per-session usage log** (a single source of truth). It is integrated with full feature parity to the existing platforms: ingest → parse → store → visualize → price. It is explicitly **not** an aggregation/roll-up of the underlying agents omp spawns.

## Resolved Decisions

| # | Branch | Decision |
|---|--------|----------|
| D1 | Data source | omp emits its **own** consolidated usage log per session (single source of truth). Integration reads omp's log directly — **not** aggregated from underlying spawned agents. |
| D2 | Platform model | omp is a **new top-level platform**, a peer alongside "Claude Code" and "Codex". |
| D3 | Scope | **Full feature parity**: ingest → parse → store → visualize → price, mirroring the existing integrations. |
| D4 | Hierarchy | **Flat token totals per omp session**. No delegation-tree / subagent breakdown required. |
| D5 | Pricing | omp has its **own pricing config** (mirrors the others). Cost is computed from omp's config, **not** derived from underlying models. |
| D6 | Data location/format | Exact omp log format/path is **unknown**; DrPe will research/discover it. The **requirement** that an omp ingest source exists is binding regardless. |

## Functional Requirements

> "omp" below refers to the new platform. Each requirement is testable against
> the observable behavior of the existing two platforms as the parity reference.

**FR-1 — Platform registration.** omp is registered as a first-class, selectable platform across every existing integration touch point: ingest parser (`lib/ingest/`), core logic (`lib/core/`), storage layer, CLI flags (`lib/cli.js`), dashboard UI (`public/index.html`, `lib/dashboard.js`), and pricing config. A user can choose "omp" anywhere they can choose "Claude Code" or "Codex".

**FR-2 — Ingest source.** A dedicated omp ingest path reads omp's own consolidated per-session usage log from a configurable source (path/location). The source is identified by research; if multiple candidate sources exist, the one designated authoritative by research is used and documented. There MUST be an omp ingest source — this requirement survives regardless of format specifics.

**FR-3 — Parser → unified record.** The omp parser maps omp log entries onto the project's existing unified token-usage record schema used for Claude Code and Codex (session id, timestamp, model, token counts, etc.). Any omp-specific fields that have no unified-schema equivalent are handled deterministically (mapped where sensible, ignored only when non-token-related) without breaking existing platforms. Records are flat per session (D4).

**FR-4 — Storage parity.** omp records are persisted by the storage layer identically to other platforms — same store, queryable and retrievable by platform = "omp".

**FR-5 — CLI parity.** The CLI exposes omp as an ingest/selection target mirroring how Claude Code and Codex are selected (e.g., flag, subcommand, or platform argument). Selecting omp ingests and processes omp data; the existing platform selection semantics are preserved unchanged.

**FR-6 — Dashboard parity.** omp appears as a selectable top-level platform in the dashboard and renders the same per-session token visualizations and computed cost as the other platforms. No omp-specific UI is required beyond what parity demands.

**FR-7 — Pricing config.** An omp pricing config exists and is applied to compute cost for omp sessions. Cost is computed solely from omp's own config (D5); it is never derived from underlying model pricing. If an omp log references a model with no configured price, behavior follows the project's existing "unknown model" handling for the other platforms.

**FR-8 — No regression.** Existing Claude Code and Codex functionality, data, and tests remain unchanged in behavior. omp is additive.

## Non-Goals

- **NG-1 — NOT an aggregation roll-up.** omp support does NOT aggregate or sum token usage from the underlying agents omp spawns (Claude Code, Codex, etc.). omp data comes only from omp's own consolidated log.
- **NG-2 — NOT a subagent/hierarchy breakdown.** No delegation-tree visualization, no per-subagent or per-node breakdown. Only flat per-session totals (D4).
- **NG-3 — NOT cross-platform linking.** omp sessions are not correlated/joined back to their underlying agent runs.
- **NG-4 — NOT new dashboard infrastructure.** Reuse the existing UI/component patterns; no platform-specific UI framework changes beyond parity.
- **NG-5 — NOT a custom pricing engine.** omp reuses the existing pricing mechanism; only its config entries are new.

## Input / Output Contract

**Input (omp log)** — Format and exact path are TBD (research). Requirements the input must satisfy:
- Must be machine-readable and per-session addressable (each session's usage is a distinct, consolidatable unit).
- Must carry, at minimum, the data needed to populate the unified token record schema: a session identifier, a timestamp (or equivalent), a model identifier, and token counts sufficient for cost computation.
- If the source is file-based, its location must be configurable.

**Output (unified records + UI)** — Identical schema and shape to records produced for Claude Code and Codex, tagged with platform = "omp". The dashboard output for omp is visually and functionally consistent with the existing two platforms.

> Field-level detail is deliberately left to the SPEC, which LeadDev will write after
> DrPe's research resolves the exact omp log schema.

## Error Cases

- **EC-1 omp source not found / not configured.** Ingest reports a clear, platform-specific error and does not silently produce zero records. Existing platforms are unaffected.
- **EC-2 Malformed omp log entry.** The parser skips or rejects the offending entry deterministically, reports it (following existing parser error-reporting conventions), and continues processing valid entries. A single bad entry does not abort an otherwise-valid ingest.
- **EC-3 Empty log / session with no token data.** Handled gracefully (zero-count record or skip) consistent with how the other platforms treat empty input; no crash, no misleading totals.
- **EC-4 Unknown model in omp log.** Falls back to the project's existing "unknown model" pricing/labeling behavior used for the other platforms; never produces a silent zero or NaN cost.
- **EC-5 Missing omp pricing config.** Raises a clear configuration error rather than computing incorrect cost; mirrors existing missing-pricing behavior.
- **EC-6 Oversized / large omp log.** Processing must not hang or exhaust memory — consistent with the existing platforms' handling of large logs.

## Non-Functional Requirements

- **NFR-1 Parity of capability.** Any capability available for Claude Code/Codex (ingest, parse, store, visualize, price) is available for omp. omp is not a second-class platform.
- **NFR-2 Consistency.** omp follows the same code conventions, directory layout, and patterns as the existing platform integrations. No divergent integration style.
- **NFR-3 No performance regression.** Adding omp does not measurably degrade ingest or dashboard performance for existing platforms.
- **NFR-4 Isolation.** omp parsing/storage failures must not corrupt or block Claude Code / Codex data paths.
- **NFR-5 Testability.** omp parser, pricing application, and an ingest→store→render round-trip are covered by tests using representative (fixture) omp data.

## Acceptance Criteria

- **AC-1** "omp" is selectable as a platform in the CLI and in the dashboard wherever "Claude Code" and "Codex" are selectable.
- **AC-2** Given a representative omp usage log, ingestion produces records in storage with the same schema as the other platforms, tagged platform = "omp".
- **AC-3** The dashboard displays omp sessions with correct flat per-session token totals and cost computed from omp's pricing config.
- **AC-4** An omp session whose log references an unknown model is handled by the existing unknown-model behavior (no crash, no silent NaN/zero cost).
- **AC-5** Tests exist for: the omp parser (happy path + at least one malformed-entry case), omp pricing application, and a full ingest→store→render round-trip. The full existing test suite passes with no regressions.
- **AC-6** Removing/disabling the omp source produces a clear, non-silent error and leaves Claude Code/Codex behavior unchanged.

## Open Items

- **OI-1 (BLOCKER for SPEC, not for this REQ): omp log format & location.** DrPe to research and report the authoritative omp usage-log format, schema/fields, and default storage path. Until resolved, the SPEC cannot finalize the field-level mapping (FR-3) or input contract details. The requirement that an omp ingest source exists (FR-2) is binding regardless.
- **OI-2 (NICE-TO-HAVE): omp log retention/rotation.** If the omp source is a rolling/append log, note how multi-session and partial-session reads are handled during SPEC — no decision needed now.
