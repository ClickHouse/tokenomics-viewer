# PROJECT — Add omp (oh-my-pi) support to tokenomics-viewer

## Overview
`tokenomics-viewer` is a tool that ingests, parses, and visualizes token-usage / pricing data from AI coding agents. It currently supports **Claude Code** and **Codex** (OpenAI Codex CLI). This work adds a third first-class platform: **omp (oh-my-pi)** — treated as a top-level platform peer that emits its own consolidated per-session usage log, integrated with full feature parity.

## Original Request (verbatim)
> This project is designed to support cloude code and codex. I need you to add support for omp (oh-my-pi).

## Workflow
FULL path: REQUEST → GRILL → [RESEARCH] → SPEC → DEVELOP ⇄ VALIDATE → DONE

## Phase Status
| Phase | Status |
|-------|--------|
| REQUEST | ✅ done |
| GRILL | ✅ done — REQ.md written |
| RESEARCH | in_progress |
| SPEC | pending |
| DEVELOP | pending |
| VALIDATE | pending |
| DONE | pending |

## Resolved Decisions (from GRILL)
| # | Branch | Decision |
|---|--------|----------|
| D1 | Data source | omp emits its OWN consolidated per-session usage log (single source of truth). NOT aggregation of underlying agents. |
| D2 | Platform model | omp is a NEW top-level platform, peer to "Claude Code" and "Codex". |
| D3 | Scope | Full feature parity: ingest → parse → store → visualize → price. |
| D4 | Hierarchy | Flat token totals per omp session. No subagent-tree breakdown. |
| D5 | Pricing | omp has its OWN pricing config (mirrors others). |
| D6 | Data location/format | UNKNOWN — DrPe researching omp log format/path (OI-1). |

## Artifacts
- `.app/REQ.md` — Requirements Document (ReqGuru, 2026-07-22)

## Pending Asks
(none)
