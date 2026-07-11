# Tokenomics Viewer

Tokenomics Viewer scans local Codex and Claude Code session logs, normalizes
token usage, estimates costs from static pricing tables, and reports the results
as text, JSON, SQLite-backed data, or a local web dashboard.

The tool is local-first. It reads files from your machine and does not upload
logs or reports anywhere.

## Requirements

- Node.js 26 or newer
- No npm dependencies

`node:sqlite` is used for the SQLite-backed sync and web dashboard modes.
ClickHouse mode uses the ClickHouse HTTP interface and still needs no npm
dependencies.

## Usage

Run an in-memory text report over the default local roots:

```bash
./app.js
```

Write JSON:

```bash
./app.js --json --output report.json
```

Scan explicit paths:

```bash
./app.js /path/to/session.jsonl /path/to/archived_sessions.zip
```

Build or update a SQLite database:

```bash
./app.js --sync --db tokenomics.sqlite
```

Serve the browser dashboard:

```bash
./app.js --webserver --db tokenomics.sqlite
```

Open the printed local URL, usually:

```text
http://127.0.0.1:8787
```

Serve an existing database without rescanning logs:

```bash
./app.js --webserver --db tokenomics.sqlite --no-sync
```

Use a local ClickHouse server instead of SQLite:

```bash
chctl local server start
./app.js --sync --webserver --db-engine clickhouse
```

By default ClickHouse mode connects to `http://127.0.0.1:8123` and uses the
`tokenomics` database. Override with `--clickhouse-url`,
`--clickhouse-database`, `--clickhouse-user`, and `--clickhouse-password`, or
the matching `TOKENOMICS_CLICKHOUSE_*` environment variables.

ClickHouse inserts use large bounded batches by default: up to 100,000 rows or
32 MiB per JSONEachRow request, whichever comes first. Tune that balance with
`--clickhouse-insert-batch-rows` and `--clickhouse-insert-batch-bytes` when the
server can absorb larger inserts or the client needs a lower memory ceiling.

New ClickHouse tables are created with per-column codecs: ZSTD for text and
stored JSON, Delta+ZSTD for counters and timestamps, Gorilla+ZSTD for floats,
and T64+ZSTD for compact flags. Existing tables keep their old schema; recreate
the app tables and resync with:

```bash
./app.js --sync --db-engine clickhouse --clickhouse-reset
```

To render a report from an already-synced ClickHouse database without rescanning
logs:

```bash
./app.js --db-engine clickhouse --json
```

## Inputs

When no paths are passed, Tokenomics Viewer scans:

- `~/.claude/projects/**/*.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/**/*.zip`

Use `--source claude`, `--source codex`, `--archives`, and `--no-archives` to
control default discovery.

ZIP archives are read directly without extracting entries to disk.

## Reports

The report includes:

- totals by provider, model, project, day, week, month, year
- per-session processing metrics
- input, cache-create, cache-read, output, and reasoning-output token counts
- cost breakdown by token category
- Codex rate-limit burn summaries when rate-limit snapshots are present
- unpriced model buckets when a model is missing from the static pricing table

## SQLite Mode

`--sync --db <path>` stores normalized rows in SQLite:

- `sources`
- `sessions`
- `usage_events`
- `rate_limit_samples`

Sync is incremental by source fingerprint. If a JSONL file or ZIP entry changes,
that source is replaced in a transaction instead of duplicated.

Generated SQLite files and reports are ignored by `.gitignore`.

## ClickHouse Mode

`--db-engine clickhouse` stores the same normalized rows in ClickHouse tables:

- `sources`
- `sessions`
- `usage_events`
- `rate_limit_samples`

The web dashboard reuses the report produced by startup sync instead of
rebuilding it for every API request. In ClickHouse mode, summary buckets are
computed with ClickHouse aggregations rather than streaming all usage rows into
Node.js. Sync streams normalized rows into ClickHouse in bounded chunks, so large
session files do not need to fit in the JavaScript heap. `--clickhouse-reset`
drops and recreates the four Tokenomics tables before sync; use it when changing
ClickHouse schema details such as codecs.

## Web Dashboard

`--webserver` serves:

- `/` dashboard HTML
- `/api/summary`
- `/api/sessions`
- `/api/report`

The dashboard shows canvas-based daily token-flow, cost-mix, and per-project
daily cost charts with mouse-wheel zoom and drag selection. Hover labels use the
same `tokens / $amount / percent` format for input, cache, and output. The
dashboard also includes global efficiency cards and an effort table with
priced-request share, total cost per priced token/output, output-only cost per
priced output token, cache share, reasoning share, and approximate request-level
output `chars/token` p10/avg/p99 metrics. Output `chars/token` samples above
10 are treated as log-shape outliers and excluded from the displayed range.
Efficiency-table monetary metrics, cache share, and reasoning share use only
priced requests; rows with no priced requests display `n/a` for price-derived
values.

The server binds to `127.0.0.1` by default. Use `--host` only if you understand
that reports can contain local file paths, project names, usage patterns, and
estimated spending.

## Pricing

Pricing is a static table in `app.js`. Treat estimates as audit aids, not
billing truth. Verify current provider pricing before relying on the numbers for
financial decisions.

GPT-5.6 Sol, Terra, and Luna use separate input, 30-minute cache-write, and
cache-read prices. Codex logs are interpreted conservatively: the legacy
`input_tokens` plus `cached_input_tokens` format treats the cached amount as a
subset of input (read only), while the explicit
`cache_creation_input_tokens` plus `cache_read_input_tokens` format records a
30-minute cache write separately. A legacy log cannot prove a cache-write
quantity, so the estimate leaves that bucket at zero instead of inferring it
from input. Source: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>.

## Privacy

Session logs, generated reports, and SQLite databases can contain sensitive
metadata such as local paths, project names, timestamps, model names, and usage
patterns. Do not publish generated output unless you have reviewed it.

## Development

Run tests:

```bash
node --test
```

Check syntax:

```bash
node --check app.js
```
