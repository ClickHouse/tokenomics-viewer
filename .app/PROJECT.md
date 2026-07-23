# PROJECT — Add omp (oh-my-pi) support to tokenomics-viewer

## Overview
`tokenomics-viewer` is a tool that ingests, parses, and visualizes token-usage / pricing data from AI coding agents. It currently supports **Claude Code** and **Codex** (OpenAI Codex CLI). The user wants to add support for **omp (oh-my-pi)** as a third integrated agent platform.

## Original Request (verbatim)
> This project is designed to support cloude code and codex. I need you to add support for omp (oh-my-pi).

## Workflow
FULL path: REQUEST → GRILL → [RESEARCH] → SPEC → DEVELOP ⇄ VALIDATE → DONE

## Phase Status
| Phase | Status |
|-------|--------|
| REQUEST | in_progress |
| GRILL | pending |
| RESEARCH | pending |
| SPEC | pending |
| DEVELOP | pending |
| VALIDATE | pending |
| DONE | pending |

## Context
- Project: `~/github/tokenomics-viewer` (Node.js)
- Existing integrations: Claude Code, Codex — mirrored in `lib/ingest/`, `lib/core/`, detection/CLI/dashboard wiring.
- Likely touch points: ingest parser, provider/platform detection, pricing config, CLI flags, dashboard UI, tests.

## Open Questions (to resolve in GRILL)
1. Where does omp store its usage data? What is the file format / schema?
2. Which viewer features should omp support (usage, pricing, timeline, rate-limits, subscription detection)?
3. How should omp usage be detected/discovered (path patterns)?
4. Naming conventions for the platform identifier ("omp"? "oh-my-pi"?).

## Pending Asks
(none yet)
