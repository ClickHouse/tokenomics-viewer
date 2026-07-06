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

## Web Dashboard

`--webserver` serves:

- `/` dashboard HTML
- `/api/summary`
- `/api/sessions`
- `/api/report`

The server binds to `127.0.0.1` by default. Use `--host` only if you understand
that reports can contain local file paths, project names, usage patterns, and
estimated spending.

## Pricing

Pricing is a static table in `app.js`. Treat estimates as audit aids, not
billing truth. Verify current provider pricing before relying on the numbers for
financial decisions.

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
