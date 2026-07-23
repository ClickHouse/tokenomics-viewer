# PROJECT — Add omp (oh-my-pi) support to tokenomics-viewer

## Overview
`tokenomics-viewer` ingests/parses/visualizes token-usage + pricing for AI coding agents. Previously supported **Claude Code** and **Codex**. This work adds a third first-class platform: **omp (oh-my-pi)** — a top-level platform peer emitting its own consolidated per-session usage log, integrated with full feature parity (ingest→parse→store→visualize→price).

## Original Request (verbatim)
> This project is designed to support cloude code and codex. I need you to add support for omp (oh-my-pi).

## Workflow
FULL path: REQUEST → GRILL → [RESEARCH] → SPEC → DEVELOP ⇄ VALIDATE → DONE

## Phase Status
| Phase | Status |
|-------|--------|
| REQUEST | ✅ | GRILL | ✅ | RESEARCH | ✅ | SPEC | ✅ | DEVELOP | ✅ | VALIDATE | ✅ PASS | DONE | in_progress (DocWorm) |

## Resolved Decisions (GRILL): D1 omp's own log · D2 top-level peer · D3 full parity · D4 flat per-session · D5 omp's own pricing config · D6 format researched.
## Resolved Architecture (SPEC): A1 JSONL sessions source · A2 provider="omp" discriminator, no schema migration · A3 provider pinned in parser · A4 rate-limit/subscription out of scope · A5 re-derive cost via calculateCost · A6 ingest all session-tree jsonl.

## VALIDATE result (Validator, independent)
- VERDICT: **PASS**. Suite 209/209, zero regressions.
- 8/8 binding invariants A1–A6 PASS (file:line evidence). 6/6 acceptance criteria PASS.
- Field mapping §11 PASS; pricing correctness PASS (real Z.AI values, authoritative source URL); out-of-scope files untouched.
- F-1 (MINOR, non-blocking): missing/empty omp source → zero report @ exit 0; at full parity with Claude/Codex (intentional SPEC decision). Optional enhancement: parity-preserving zero-source warning for all platforms (deferred to user).

## Artifacts
- `.app/REQ.md` · `.app/RESEARCH.md` (format) · `.app/SPEC.md`
- Integration Map `agent://LeadDevPatternMap` · Pricing `agent://DrPeGlmPricing`

## Pending Asks
(none)
