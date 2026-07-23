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
| RESEARCH | ✅ done — RESEARCH.md + integration map |
| SPEC | in_progress |
| DEVELOP | pending |
| VALIDATE | pending |
| DONE | pending |

## Resolved Decisions (GRILL)
| # | Decision |
|---|----------|
| D1 | omp emits its OWN consolidated per-session usage log (single source of truth); NOT aggregation of underlying agents. |
| D2 | omp is a NEW top-level platform, peer to "Claude Code"/"Codex". |
| D3 | Full feature parity: ingest→parse→store→visualize→price. |
| D4 | Flat per-session totals; no subagent-tree breakdown. |
| D5 | omp has its OWN pricing config; cost computed from it. |
| D6 | omp log format/path researched by DrPe (OI-1 resolved). |

## Resolved Architectural Decisions (RESEARCH → SPEC)
| # | Decision |
|---|----------|
| A1 (OQ-1) | omp source = JSONL session transcripts at `~/.omp/agent/sessions/<project-slug>/<ISO-ts>_<uuid>.jsonl`; usage block per assistant message. Relocatable via `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR`. |
| A2 (OQ-2) | No schema migration. `provider="omp"` IS the platform discriminator; omp surfaces in existing provider/model breakdowns. FR-4 satisfied via provider queryability. |
| A3 (OQ-3) | New provider string `"omp"`. Parser MUST pin provider explicitly (mirror Codex), defeating `inferProvider` so omp's `claude-*`/`gpt-*` model refs are never mispriced as anthropic/openai. |
| A4 (OQ-4) | Rate-limit/quota + subscription-plan detection for omp are OUT OF SCOPE (D4/NG-2/NG-3). |
| A5 (cost) | Re-derive cost from the viewer's omp pricing config (D5); omp's precomputed log cost is often zero/unreliable. |
| A6 (subagents) | Ingest includes omp's OWN subagent sidecar `.jsonl` (part of omp's own logs, not the Claude/Codex integrations). v1: process all session-tree jsonl files; no parent-only toggle (YAGNI). |

## Artifacts
- `.app/REQ.md` — Requirements (ReqGuru)
- `.app/RESEARCH.md` — omp log format & location (DrPe)
- Integration Map — `agent://LeadDevPatternMap` (LeadDev)

## Pending Asks
(none)
