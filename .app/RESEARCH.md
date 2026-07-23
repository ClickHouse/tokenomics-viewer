# Research: omp (oh-my-pi) usage-log format & location

> **Access date for all web sources:** 2026-07-22. Evidence base: live local
> inspection of `~/.omp/` on this machine (which is running omp right now),
> corroborated against the official pi/omp documentation and source on GitHub.

---

## Executive Summary

omp does **not** write a separate pre-aggregated "billing" or "usage summary" file.
The authoritative per-session token-usage data is embedded **inside the per-session
JSONL transcript** at `~/.omp/agent/sessions/<project-slug>/<ISO-timestamp>_<session-uuid>.jsonl`:
every assistant model response is a `{"type":"message", …}` line carrying a `usage`
block (input/output/cache tokens + a precomputed `cost` in USD). A consolidated
per-session total is therefore **derived by summing those `usage` blocks** across one
file (and, if full-cost accounting is desired, across the sibling subagent transcripts
in the session's sidecar directory).

---

## Scope

Researched how omp records token usage / billing / cost data, in service of OI-1
(the format/path blocker for the tokenomics-viewer omp integration). Dimensions
covered: authoritative source, default path & session identity, schema/fields,
per-session consolidation, multi-session/retention, and configurability. Sources:
(1) **LOCAL** — recursive inspection of `~/.omp/` (SQLite stores `agent.db`,
`history.db`, `models.db`; the `sessions/` JSONL tree; `config.yml`); representative
session files read across three independent projects; (2) **WEB** — the official pi
session-format docs (`pi.dev`), the omp environment-variables docs (`omp.sh` + the
`can1357/oh-my-pi` GitHub source). Non-goals honored: no code written, no
investigation of the existing Claude Code/Codex parsers.

---

## Findings

### 1. Authoritative source = the session JSONL transcripts (NOT the SQLite DBs)

omp stores three SQLite databases under `~/.omp/agent/` (`agent.db`, `history.db`,
`models.db`). Their tables are **not** per-session usage stores:

| DB / table | Schema (key columns) | What it actually is | Verdict for ingest |
|---|---|---|---|
| `agent.db → usage_history` | `recorded_at, provider, account_key, limit_id, label, window_label, used_fraction, status, resets_at` | **Provider account quota** tracking (e.g. `label="ZAI Tokens"`, `window_label="Quota"`, `used_fraction=0.04`, `status=ok`). No session id, no token counts per call. | ❌ Not per-session |
| `agent.db → usage_cost_history` | `recorded_at, provider, account_key, cost_usd` | Provider cost ledger (empty: 0 rows on this box). | ❌ Not per-session |
| `agent.db → model_perf` | `model_key, samples, output_tokens, gen_ms, ttft_ms, updated_at` | **Global** per-model performance aggregate (e.g. `zai/glm-5.2 | samples=188 | output_tokens=200376`). Not keyed by session. | ❌ Not per-session |
| `agent.db → model_usage` | `model_key, last_used_at` | Last-used timestamp per model. | ❌ Not per-session |
| `history.db → history` | `id, prompt, created_at, cwd, session_id` | User-prompt history index (a `session_id` column exists but is NULL on older rows). Usable as a *session-discovery* aid, carries no tokens/cost. | ❌ Not for usage (supplementary only) |
| `models.db → model_cache` | model discovery cache | Provider/model metadata. | ❌ Not per-session |

There is **no** `~/.omp/billing/`, `~/.omp/usage/`, or `~/.omp/metrics*` directory;
the top-level `~/.omp/` contains `agent/`, `logs/`, `plugins/`, `run/`, `cache/`,
`natives/`, plus config files. **The token/cost data lives exclusively in the JSONL
session transcripts** (`~/.omp/agent/sessions/…`), confirmed by reading real records
(see Finding 3).

> **Designate this as authoritative:** the parser reads the session JSONL transcripts.
> The SQLite `usage_history`/`model_perf` tables are a tempting but wrong target —
> they record *provider quota consumption* and *global perf aggregates*, not session
> spend.

### 2. Default path & session identity (corroborated by official docs)

**Local default (observed):**
```
~/.omp/agent/sessions/<project-slug>/<timestamp>_<session-uuid>.jsonl
```
Real example from this very project:
```
~/.omp/agent/sessions/-github-tokenomics-viewer/2026-07-23T00-40-00-339Z_019f8c6a-3c53-7000-ac25-ab8ebe94e943.jsonl
```

**Official doc** (upstream pi framework that omp is built on — omp swaps `~/.pi` → `~/.omp`):
> `~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl` — *where `<path>` is the
> working directory with `/` replaced by `-`.*
Source: https://pi.dev/docs/latest/session-format (accessed 2026-07-22).

Session identity:
- **Session UUID** — the `<session-uuid>` in the filename, and the `id` field inside
  the first line (`SessionHeader`). Example: `019f8c6a-3c53-7000-ac25-ab8ebe94e943`.
- **Timestamp** — ISO-8601 in the filename and the header `timestamp`; colons/most
  punctuation are rendered as `-` in the filename (`2026-07-23T00-40-00-339Z`).
- **Project-scoping** — one subdirectory per working directory (the `<project-slug>`).
  Observed: `/Users/roki/github/tokenomics-viewer` → `-github-tokenomics-viewer`
  (i.e. the `$HOME`-relative path with `/`→`-`, prefixed by `-`). Because the exact
  slug derivation is fiddly, the parser should simply **glob all `*/` subdirectories**
  rather than derive the slug.

Each session also has an optional **sidecar directory** of the same name (minus
`.jsonl`) holding **subagent transcripts** named `<AgentName>.jsonl` (see Finding 5).

### 3. Schema / fields — where token counts, model id, and cost live

Each file is JSONL; each line is one JSON object with a `type`. The session header is
the first line:

```json
{"type":"session","version":3,"id":"019f8c6a-3c53-7000-ac25-ab8ebe94e943","timestamp":"2026-07-23T00:40:00.339Z","cwd":"/Users/roki/github/tokenomics-viewer","title":"Add oh-my-pi support","titleSource":"auto"}
```

**Token usage rides on assistant message lines.** A real record (this project's session,
lightly trimmed), showing every field an ingest parser needs:

```json
{
  "type": "message",
  "id": "4f9506d3", "parentId": "7d542783",
  "timestamp": "2026-07-23T00:42:17.380Z",
  "message": { "role": "assistant", "content": [ … ] },
  "api": "anthropic-messages",
  "provider": "zai",
  "model": "glm-5.2",
  "usage": {
    "input": 994, "output": 57,
    "cacheRead": 39232, "cacheWrite": 0,
    "totalTokens": 40283,
    "cost": {
      "input": 0.0013916, "output": 0.0002508,
      "cacheRead": 0.01020032, "cacheWrite": 0,
      "total": 0.01184272
    }
  },
  "stopReason": "toolUse",
  "timestamp": 1784767330214,
  "responseId": "msg_…"
}
```

Field meaning (verified against https://pi.dev/docs/latest/session-format):

- **Session id** → header `id` (UUID) = `<session-uuid>` in filename.
- **Timestamps** → header `timestamp` (ISO) = session start; each assistant call has
  its own `timestamp` (see gotcha below).
- **Model identifier** → `model` (e.g. `glm-5.2`) **plus** `provider` (e.g. `zai`) on
  the message line. Note the active model is also recorded separately in
  `{"type":"model_change","model":"zai/glm-5.2","role":"default"}` lines, where it
  appears in the combined `provider/model` form. (The `role` distinguishes
  default/slow/smol/advisor model slots from `~/.omp/agent/config.yml → modelRoles`.)
- **Prompt / input tokens** → `usage.input`.
- **Completion / output tokens** → `usage.output`.
- **Cache tokens** → `usage.cacheRead` (prompt-cache hits) and `usage.cacheWrite`.
- **Total tokens** → `usage.totalTokens`. **Verified arithmetic:**
  `totalTokens = input + output + cacheRead + cacheWrite`
  (994 + 57 + 39232 + 0 = 40283 ✅). I.e. total **includes** cache tokens.
- **Cost** → `usage.cost.total`, precomputed in USD, with per-bucket breakdown
  (`input`/`output`/`cacheRead`/`cacheWrite`). omp **does** price cache tokens (the
  record above charges $0.0102 for 39,232 cache-read tokens).
- **`stopReason`** ∈ `stop | length | toolUse | error | aborted`.

#### ⚠️ Two real gotchas observed on disk
1. **Duplicate `timestamp` key.** omp flattens both the entry-level and message-level
   fields onto one JSON object. The entry `timestamp` is an **ISO string**; the
   message `timestamp` is a **Unix-ms number** — and both appear at the same object
   level. `JSON.parse` keeps the **last** one, so `obj.timestamp` resolves to the
   **number (ms)**, not the ISO string. Both encode ~the same instant (a few seconds
   apart). The parser must not assume `timestamp` is a string after a naive parse.
2. **Cost can be `0` across the board** when omp has no price for the model/provider.
   Real example (a `zai/glm-5.2` call early in the box's history):
   `"usage":{"input":28864,"output":81,"cacheRead":0,"cacheWrite":0,"totalTokens":28945,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}}`.
   → The ingest viewer should be able to *re-derive* cost from its own pricing config
   (matches REQ decision Q5: "omp's own pricing config") rather than trusting `cost`
   blindly.

#### Secondary usage source: `ToolResultMessage.usage`
Per the official type defs, a `{"role":"toolResult", …}` message may carry an optional
`usage` ("Nested LLM work performed by the tool"). For an exact session total, **sum
this too** when present (some tools do hidden LLM calls and report them here). The
authoritative `Usage` shape (from the docs):

```ts
interface Usage {
  input: number; output: number;
  cacheRead: number; cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; };
}
```

### 4. Per-session consolidation

There is **no** pre-aggregated per-session total in any file. A consolidated per-session
usage row is **derived** by scanning one `.jsonl`, taking every line where
`message.role === "assistant"` (and optionally every `toolResult` line that has a
`usage`), and summing each `usage` sub-field independently:
```
session.input     = Σ usage.input
session.output    = Σ usage.output
session.cacheRead = Σ usage.cacheRead
session.cacheWrite= Σ usage.cacheWrite
session.totalTokens = Σ usage.totalTokens   (= Σ of the four buckets)
session.cost      = Σ usage.cost.total
```
This is exactly the "flat per-session total" REQ decision Q4 calls for, and it is
fully derivable from the single source. Per-model breakdown within a session is also
trivial: group the same summation by the message's `provider`/`model`.

### 5. Multi-session, retention & subagent representation

- **One file per session**, append-only (each model call appends a line). Multiple
  sessions per project, multiple projects — all under `~/.omp/agent/sessions/`.
  Oldest file observed on this box dates to 2025/2026-05 (≈2 months); files persist
  until deleted. (Old *app logs* under `~/.omp/logs/` get gzipped, but session
  transcripts are not auto-rotated.)
- **Subagents are separate transcripts.** When a session spawns subagents (e.g. the
  elon-ko orchestrator), their per-call usage is **not** in the parent `.jsonl` — it
  lands in per-agent files inside the session's sidecar directory, e.g.
  `…/019f8c6a-…/<AgentName>.jsonl` (`ReqGuruGrill.jsonl`, `LeadDevPatternMap.jsonl`,
  `DrPeOmpFormat.jsonl`). Each subagent file uses the **identical** format (its own
  `{"type":"session",…}` header, model_change, and assistant `usage` lines).
  → **Scoping decision for the viewer:** "session total" can mean (a) the parent
  thread only, or (b) parent + all subagents. Counting subagents = also walking the
  sidecar directory's `*.jsonl`. Recommend (b) for true cost, exposed as a toggle.
- **Forks/compactions:** a header may carry `parentSession` (path to the original
  session file) for `/fork`/`/clone`; `compaction` entries embed a `retainedTail` that
  can itself contain assistant `usage` blocks — the parser should not double-count
  these (they are replayed context, not new spend).

### 6. Configurability (paths are env-configurable)

From the official omp env reference (https://omp.sh/docs/env and the source
`can1357/oh-my-pi/blob/main/docs/environment-variables.md`, accessed 2026-07-22), the
data roots are relocatable via `@oh-my-pi/pi-utils/dirs`:

- **`PI_CONFIG_DIR`** — renames the config root under `$HOME` (default `.`, i.e.
  `~/.omp`). So the sessions tree is `<$HOME>/<PI_CONFIG_DIR or ".omp">/agent/sessions`.
- **`PI_CODING_AGENT_DIR`** — moves the **agent data directory** off the default
  `~/.omp/agent` (the directory that holds `sessions/`, `agent.db`, `config.yml`).
  The env doc notes this is "useful on shared boxes or when isolating profiles."
- `.env` resolution chain (lowest→highest precedence, from the source): home
  `~/.env` → config-root `~/.omp/.env` → agent `~/.omp/agent/.env` → project
  `$PWD/.env` → process env; inside each file `OMP_*` keys are mirrored to `PI_*`.

Practical guidance for the viewer: resolve the omp root as
`process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), process.env.PI_CONFIG_DIR || '.omp', 'agent')`
and then append `/sessions`. Default on a stock install: `~/.omp/agent/sessions`.

---

## Schema reference table

| Concept | omp location | Key(s) | Notes |
|---|---|---|---|
| Session id | header line | `id` (UUID); also filename `<uuid>` | One header per file |
| Session start time | header line | `timestamp` (ISO 8601) | = filename `<timestamp>` |
| Project / cwd | header line | `cwd` (abs path) | Slug = `$HOME`-relative path, `/`→`-` |
| Per-call input tokens | assistant msg | `usage.input` | prompt tokens |
| Per-call output tokens | assistant msg | `usage.output` | completion tokens |
| Cache read tokens | assistant msg | `usage.cacheRead` | priced by omp |
| Cache write tokens | assistant msg | `usage.cacheWrite` | |
| Per-call total | assistant msg | `usage.totalTokens` | = input+output+cacheRead+cacheWrite |
| Per-call cost (USD) | assistant msg | `usage.cost.total` | precomputed; may be 0 if unpriced |
| Cost breakdown | assistant msg | `usage.cost.{input,output,cacheRead,cacheWrite}` | |
| Model id | assistant msg | `model` (+ `provider`) | combined form `provider/model` in `model_change` |
| API/protocol | assistant msg | `api` | e.g. `anthropic-messages`, `openai-responses` |
| Call outcome | assistant msg | `stopReason` | `stop\|length\|toolUse\|error\|aborted` |
| Hidden LLM (tool) usage | toolResult msg | `usage?` (optional, same `Usage` shape) | sum for exact totals |
| Nested-tool work | toolResult msg | `details` (tool-specific) | not usage |
| Provider quota (NOT session) | `agent.db:usage_history` | `used_fraction, status, resets_at` | do not ingest for per-session spend |
| Global model perf (NOT session) | `agent.db:model_perf` | `output_tokens, samples` | global aggregate only |

---

## Recommendations for the ingest parser

1. **Read `~/.omp/agent/sessions/**/*.jsonl`.** This is the single authoritative
   per-session token/cost source (Finding 1). Ignore the SQLite tables for usage.
   *Rationale:* every line with tokens/cost lives here; the DBs track quota/perf.
2. **Identify a session from the header line** (`{"type":"session","version":3,"id":…}`):
   use `id` as the session id and `timestamp` as start time; derive the human label
   from `cwd`/`title`. One session = one file (Finding 2).
3. **Map fields 1:1:** `usage.input→promptTokens`, `usage.output→completionTokens`,
   `usage.cacheRead→cacheReadTokens`, `usage.cacheWrite→cacheWriteTokens`,
   `usage.cost.total→costUsd`, and `provider`+`model`→model id (Finding 3). Cache is
   first-class — surface it like Claude Code does.
4. **Consolidate by summation**, not by reading a summary: iterate lines, filter
   `message.role==="assistant"` (plus `toolResult` lines that carry `usage`), and sum
   each bucket. Provide a per-model group-by on `provider/model` (Finding 4).
5. **Handle the two gotchas:** (a) the duplicate `timestamp` key — after `JSON.parse`,
   `timestamp` is the Unix-ms number, not the ISO string; read the header's ISO
   `timestamp` for the session start and treat the per-call `timestamp` as ms. (b) Cost
   may be all-zero for unpriced models — recompute from the viewer's own omp pricing
   config (REQ Q5) and flag rows where omp's `cost.total` is 0 but tokens > 0.
6. **Decide subagent scope:** default to parent-thread-only totals, with an option to
   include sidecar `<AgentName>.jsonl` files for full session cost (Finding 5).
7. **Resolve the root portably:** honor `PI_CODING_AGENT_DIR` then `PI_CONFIG_DIR`
   before falling back to `~/.omp/agent/sessions` (Finding 6). Glob all project
   subdirectories; do not try to reconstruct the cwd-slug.

---

## Impact Assessment

- **Verdict: EXPAND (minor).**
- **Affected assumption:** REQ OI-1 framed the source as "omp's own **consolidated**
  per-session usage log." The finding corrects this: omp's per-session usage is
  **embedded in the JSONL transcript** as per-call `usage` blocks; there is **no
  separate consolidated/summary file**, and the SQLite tables are quota/perf stores,
  not usage. Consolidation must be computed by the parser (this is normal — the
  Claude Code/Codex parsers aggregate too, so no architectural change is implied).
- **Two decisions to confirm (lightweight):**
  1. **Subagent scope** — does "session total" include subagent transcripts
     (sidecar `*.jsonl`), or parent thread only? (Recommend: include, behind a toggle.)
  2. **Cost source** — trust omp's `usage.cost.total`, or always re-derive from the
     viewer's omp pricing config (handles the all-zero/unpriced case)? (Recommend:
     re-derive, since REQ Q5 already chose "omp's own pricing config.")
- **Explanation:** OI-1 (exact format & path) is **fully resolved** — the schema,
  path, identity, consolidation rule, and configurability are all established with
  primary-source + on-disk evidence. Nothing contradicts the feature; the only change
  is parser-side aggregation + the two minor scoping choices above.
- **Recommendation: PROCEED to SPEC (LeadDev).** No GRILL re-interview required; the
  two decisions above can be defaulted per the recommendations and confirmed during
  SPEC without blocking.

---

## Open / Unresolved items

- **Subagent scope decision** (parent-only vs parent+subagents) — flagged for SPEC;
  recommendation provided.
- **Cache-write pricing semantics:** `cacheWrite` tokens are always 0 in the records
  inspected (the `zai/glm-5.2` provider shows no cache writes). The field exists in
  the schema and omp prices it in `cost.cacheWrite`; the viewer's pricing config must
  carry a cache-write rate, but no real value was observed to validate it.
- **`api` field enumeration:** observed `anthropic-messages`; `openai-responses` and
  others exist per the env docs. Not needed for usage math but useful for display.
- **Filename timestamp format edge cases:** the on-disk form renders ISO punctuation
  as `-` (`2026-07-23T00-40-00-339Z`); parser should split on the final `_` to
  separate `<timestamp>` from `<uuid>`, not rely on a fixed ISO parse of the filename.

---

## Sources Consulted

1. **LOCAL — `~/.omp/`** (this machine). Inspected `agent/agent.db`, `agent.db:usage_history`,
   `model_usage`, `usage_cost_history`, `model_perf`; `history.db:history`;
   `models.db`; `agent/config.yml`; and session transcripts under
   `agent/sessions/-github-tokenomics-viewer/…` and `-github-omp/…`. Confirmed the
   SQLite tables are quota/perf stores and the JSONL transcripts carry all token/cost
   data. (Primary; highest confidence.)
2. **Session File Format — pi.dev**,
   https://pi.dev/docs/latest/session-format (accessed 2026-07-22). Authoritative type
   definitions: `SessionHeader`, `AssistantMessage` (with `api/provider/model/usage/cost`),
   `ToolResultMessage.usage`, `Usage` interface, `SessionEntryBase`, path template,
   version history (v3 current). Mirrors the on-disk records exactly.
3. **Environment Variables — omp.sh**, https://omp.sh/docs/env (accessed 2026-07-22).
   Documents relocating the agent data dir (`~/.omp/agent`) and config root; names
   `PI_CONFIG_DIR` / the agent-dir override.
4. **environment-variables.md — `can1357/oh-my-pi` (GitHub source)**,
   https://github.com/can1357/oh-my-pi/blob/main/docs/environment-variables.md
   (accessed 2026-07-22). Confirms `.env` resolution chain respecting
   `PI_CONFIG_DIR` / `PI_CODING_AGENT_DIR`, and the `OMP_*`→`PI_*` mirroring rule.
5. **cmux issue #4955** (context only), https://github.com/manaflow-ai/cmux/issues/4955 —
   corroborates omp is a published variant of pi-coding-agent with config dir `~/.omp`
   (vs pi's `~/.pi`).
6. **pi issue #104 — "ccusage compatibility for session logs"** (context only),
   https://github.com/earendil-works/pi/issues/104 — notes pi/omp session logs live in
   `~/.pi`/`~/.omp` (not `~/.claude/projects/`) and use this JSONL format, relevant
   precedent for a usage-viewer integration.
