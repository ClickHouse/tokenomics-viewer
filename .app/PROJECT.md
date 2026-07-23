# PROJECT — Add omp (oh-my-pi) support to tokenomics-viewer

## Overview
`tokenomics-viewer` ingests/parses/visualizes token-usage + pricing for AI coding agents. Currently supports **Claude Code** and **Codex**. This work adds a third first-class platform: **omp (oh-my-pi)** — a top-level platform peer emitting its own consolidated per-session usage log, integrated with full feature parity (ingest→parse→store→visualize→price).

## Original Request (verbatim)
> This project is designed to support cloude code and codex. I need you to add support for omp (oh-my-pi).

## Workflow
FULL path: REQUEST → GRILL → [RESEARCH] → SPEC → DEVELOP ⇄ VALIDATE → DONE

## Phase Status
| Phase | Status |
|-------|--------|
| REQUEST | ✅ done |
| GRILL | ✅ done — REQ.md |
| RESEARCH | ✅ done — RESEARCH.md (format) + GLM pricing (in code) + integration map |
| SPEC | ✅ done — SPEC.md |
| DEVELOP | ✅ done — 8 commits, 209/209 tests pass, real Z.AI pricing applied |
| VALIDATE | in_progress |
| DONE | pending |

## Resolved Decisions (GRILL): D1 omp's own log · D2 top-level peer · D3 full parity · D4 flat per-session · D5 omp's own pricing config · D6 format researched.
## Resolved Architecture (SPEC): A1 JSONL sessions source · A2 provider="omp" discriminator, no schema migration · A3 provider pinned in parser · A4 rate-limit/subscription out of scope · A5 re-derive cost via calculateCost · A6 ingest all session-tree jsonl.

## DEVELOP result (LeadDev, independently verified)
- Commits: C1 constants → C2 CLI → C3 discovery → C4 parser+mapper → C5 pricing plumbing → C6 tests → C7 README/keywords → [SPEC §6] real Z.AI pricing.
- Tests: **209 pass / 0 fail** (+new omp tests: parser happy-path, malformed, pricing known/unknown, discovery round-trip, CLI env; +1 A5 re-derivation proof). Zero regressions.
- Smoke: zero-cost omp fixture → re-derived `costUsd=0.01184272` `known:true` from real Z.AI rates; provider pinned `omp`; duplicate-timestamp gotcha handled.
- OI-S1 RESOLVED: real GLM pricing (14 models, USD/Mtok) from official https://docs.z.ai/guides/overview/pricing applied to PRICING.omp.models.
- OI-S2 moot (cacheCreate tiers free/zero). OI-S3 deferred (YAGNI).
- Note: DrPeGlmPricing briefly overwrote RESEARCH.md with the pricing doc; restored to the format doc (pricing values preserved in pricing.js + agent://DrPeGlmPricing).

## Artifacts
- `.app/REQ.md` · `.app/RESEARCH.md` (format) · `.app/SPEC.md`
- Integration Map — `agent://LeadDevPatternMap` · Pricing — `agent://DrPeGlmPricing`

## Pending Asks
(none)
