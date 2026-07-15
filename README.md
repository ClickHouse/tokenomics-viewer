# Tokenomics Viewer

Tokenomics Viewer scans local Codex and Claude Code session logs, normalizes
token usage, estimates costs from a database-backed pricing catalog, and reports the results
as text, JSON, SQLite-backed data, or a local web dashboard.

The tool is local-first. It reads files from your machine and does not upload
logs or reports anywhere.

## One-line setup

On macOS or Linux, install or update Tokenomics Viewer and start it with:

```bash
/bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/skuznetsov/tokenomics-viewer/main/install.sh)"
```

The installer does not use `sudo`. It installs versioned application files in
`~/.local/share/tokenomics-viewer`, creates `tokenomics`, `tokenomics-viewer`,
and `tokenomics-launch` commands in `~/.local/bin`, and then starts the
launcher. If Node.js 26 or newer is unavailable, it installs a private Node.js
26 runtime after verifying the archive against the official Node.js SHA-256
manifest.

ClickHouse is the launcher's default backend. The launcher installs it when
needed, runs the initial sync, starts the dashboard, and opens it in the default
browser without an interactive database-choice flow. SQLite remains available
as an explicit opt-out, and its data is kept across application updates at:

```text
~/.local/share/tokenomics-viewer/tokenomics.sqlite
```

Run the same one-line command again to update. To install and opt out of
ClickHouse in one command, pass the launcher flag through the shell:

```bash
/bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/skuznetsov/tokenomics-viewer/main/install.sh)" -- --sqlite
```

To install without starting the dashboard, use:

```bash
TOKENOMICS_NO_LAUNCH=1 /bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/skuznetsov/tokenomics-viewer/main/install.sh)"
```

If `~/.local/bin` is not already on `PATH`, the installer prints the exact
`export` command to add it. It does not modify shell startup files.

## Requirements

- Node.js 26 or newer
- No npm dependencies

`node:sqlite` is used for the SQLite-backed sync and web dashboard modes.
ClickHouse mode uses the ClickHouse HTTP interface and still needs no npm
dependencies.

## Local ClickHouse with clickhousectl

[`clickhousectl`](https://clickhouse.com/blog/getting-started-clickhousectl) is
the official ClickHouse CLI for installing versions and managing isolated local
servers. The installer also creates the shorter `chctl` command used below.

Install it on macOS or Linux:

```bash
curl -fsSL https://clickhouse.com/cli | sh
```

The binary is installed under `~/.local/bin`. If your shell cannot find it, add
that directory to `PATH` and restart the shell:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
clickhousectl --version
chctl --version
```

Download the current stable ClickHouse release and make it the local default:

```bash
chctl local use stable
chctl local which
```

From the Tokenomics Viewer repository, start a persistent named server on the
HTTP port expected by the application:

```bash
chctl local server start --name tokenomics --http-port 8123 --tcp-port 9000
chctl local server list
curl http://127.0.0.1:8123/ping
```

The server runs in the background and stores its data under
`.clickhouse/servers/tokenomics/`. Connect with the bundled ClickHouse client:

```bash
chctl local client --name tokenomics --query "SELECT version()"
```

Stop, restart, or permanently remove the local instance with:

```bash
chctl local server stop tokenomics
chctl local server start --name tokenomics
chctl local server stop tokenomics
chctl local server remove tokenomics
```

If port `8123` is already occupied, omit `--http-port` and inspect the assigned
port with `chctl local server list`, then pass it to Tokenomics Viewer:

```bash
chctl local server start --name tokenomics-alt
./app.js --sync --db-engine clickhouse \
  --clickhouse-url http://127.0.0.1:ASSIGNED_HTTP_PORT
```

## Usage

### Launcher

For the default local workflow, run:

```bash
./launcher.js
```

The launcher uses ClickHouse by default, installs `clickhousectl` when needed,
starts the named local server, runs Tokenomics with sync enabled, waits for the
dashboard to become ready, and opens the default browser. It reuses an existing
dashboard only when that process reports the requested backend. Older
`~/.config/tokenomics-viewer/launcher.json` choice files are ignored.

Useful launcher controls:

```bash
./launcher.js --sqlite              # opt out of ClickHouse for this launch
./launcher.js --no-clickhouse       # explicit alias for --sqlite
./launcher.js --clickhouse          # explicit ClickHouse (already the default)
./launcher.js --no-open             # do not open a browser
./launcher.js -- --source codex     # pass Tokenomics options after --
```

Unless SQLite is explicitly selected, the launcher downloads and executes the
official `https://clickhouse.com/cli` installer, selects the stable local
release, and starts the named `tokenomics` server on HTTP `8123` and TCP `9000`.
Automatic installation is supported on macOS and Linux.

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
chctl local server start --name tokenomics --http-port 8123 --tcp-port 9000
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
and T64+ZSTD for compact flags. Compatible schema additions are applied in
place. To discard and rebuild all Tokenomics-owned ClickHouse tables, use:

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
- `${CODEX_HOME:-~/.codex}/sessions/**/*.{jsonl,jsonl.zst}`
- `${CODEX_HOME:-~/.codex}/archived_sessions/**/*.{jsonl,jsonl.zst,zip}`

Use `--source claude`, `--source codex`, `--archives`, and `--no-archives` to
control default discovery.

ZIP archives and Codex Zstd-compressed rollouts are read directly without
extracting entries to disk. When both `.jsonl` and `.jsonl.zst` representations
exist during a Codex compression transition, Tokenomics reads only the plain
file.

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

Each source version is immutable. A sync stages changed sources and a complete
source manifest, then publishes one global generation marker last. Reports pin
that generation for every aggregation query, so a failed multi-source sync
leaves the previous complete report visible instead of exposing a partial mix.
Source fingerprints cover source identity and analytics derivation only. Pricing
revisions are deliberately excluded: changing a rate must not read or reimport
session files. Legacy fingerprints containing pricing fields are compared using
the same canonical form, so this migration does not trigger a one-time full
reimport. Database schema versioning remains a separate concern.

The web dashboard reuses the report produced by startup sync instead of
rebuilding it for every API request. In ClickHouse mode, summary buckets are
computed with ClickHouse aggregations rather than streaming all usage rows into
Node.js. Sync streams normalized rows into ClickHouse in bounded chunks, so large
session files do not need to fit in the JavaScript heap. `--clickhouse-reset`
drops and recreates all Tokenomics-owned tables before sync; normal upgrades do
not require a reset.

## Web Dashboard

`--webserver` serves:

- `/` dashboard HTML
- `/api/summary`
- `/api/timeline` compact 15-minute data loaded on demand for a range or project
- `/api/sessions`
- `/api/report`
- `/api/sync` sync status and protected start action
- `/api/sync/events` live sync progress over server-sent events

The dashboard shows canvas-based token-flow, cost-mix, and per-project cost
charts at 15-minute, hourly, and daily resolution; Cost Mix also retains weekly
and monthly views. Intraday rows are loaded separately from the summary and a
project timeline is fetched only for the selected project. Accumulated
mouse-wheel zoom follows the pointer, drag selects a range, and zoom can reach a
single 15-minute bucket. Small trackpad deltas are accumulated before changing
the visible range.

Each model is drawn as a stable-color point and Catmull-Rom line. A missing model
interval creates a visible break instead of implying zero or interpolated use.
Hover labels keep aggregate input/cache/output in the header and show each
model's `cost / tokens / percent` for the selected interval. Project intervals
can be pinned by click.

Analyst mode includes `Cost & Resource Diagnostics`. It reuses the Models date
range and compares effort rows only within one selected provider/model cohort.
The table reports usage-event count, tariff coverage, estimated spend, covered
input/cache/output per event, amortized total spend per output, output tariff,
cache-read share, and reasoning share. `Tariff coverage` means that the local
pricing catalog recognized an event; it does not prove that the event was billed.
`Usage event` is also deliberately not labeled as a user request or completed
task. Without outcome or quality data the section remains descriptive and does
not rank effort levels by efficiency.

The header switches between `Overview` and `Analyst` modes. Overview keeps the
model ranking to ten rows and hides project/diagnostics detail. Analyst exposes
the full stored model list and the detailed project and diagnostics sections.
Both modes show deterministic recommendation findings generated from the same
report. Recommendations include evidence, confidence, a concrete action, and a
caveat; unpriced traffic is not assumed to be billable because subscription or
intentionally non-billable models may have no API tariff.

The server binds to `127.0.0.1` by default. Use `--host` only if you understand
that reports can contain local file paths, project names, usage patterns, and
estimated spending.

The dashboard Sync button is enabled only when the webserver is bound to a
loopback host. Bindings such as `0.0.0.0` and LAN addresses remain read-only:
reports are served, but sync mutations are rejected. This is intentional;
the custom action header prevents browser CSRF but is not remote-user
authentication.

## Pricing

The first database open seeds a packaged pricing catalog from
`lib/core/pricing.js`. After that, the active catalog and analytics settings are
stored in the selected SQLite or ClickHouse database. Treat estimates as audit
aids, not billing truth. Verify current provider pricing before relying on the
numbers for financial decisions.

Open the dashboard in **Analyst** mode and use **Pricing & Analytics Settings**
to:

- inspect and edit per-million-token input, cache-write, cache-read, and output
  rates;
- add providers and models using a provider slug and model id;
- choose exact, prefix, or dated-snapshot model matching;
- set OpenAI short/long context selection and a global rate multiplier.

Configuration saves use an optimistic revision and are allowed only on a
loopback-bound dashboard. Saving applies the catalog immediately from normalized
database rows; it never rereads JSONL, ZIP, or Zstandard session sources. SQLite
derives costs from the active catalog while reading normalized rows. ClickHouse
writes a compact revisioned cost overlay with one `INSERT SELECT`, then publishes
the configuration marker last. If repricing fails, the previous configuration
and costs remain visible.

Custom providers are priced when an ingested record identifies the same provider
slug. Adding a catalog row cannot infer a provider that is absent from the source
log. `standard` means the displayed values are standard API-equivalent estimates;
switch the basis to `custom` when entering negotiated, batch, subscription, or
otherwise non-standard rates.

GPT-5.6 Sol, Terra, and Luna use separate input, 30-minute cache-write, and
cache-read prices. Codex logs are interpreted conservatively: the legacy
`input_tokens` plus `cached_input_tokens` format treats the cached amount as a
subset of input (read only), while the explicit
`cache_creation_input_tokens` plus `cache_read_input_tokens` format records a
30-minute cache write separately. A legacy log cannot prove a cache-write
quantity, so the estimate leaves that bucket at zero instead of inferring it
from input. Source: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>.

The proposed compressed session store and project-scoped session viewer are not
implemented in this slice. Their admitted safety boundary is documented in
[`docs/PRICING_CONFIGURATION_FRONTIER.md`](docs/PRICING_CONFIGURATION_FRONTIER.md).

## Privacy

Session logs, generated reports, and SQLite databases can contain sensitive
metadata such as local paths, project names, timestamps, model names, and usage
patterns. Do not publish generated output unless you have reviewed it.

## Development

`app.js` is the executable composition root. Implementation is split by
responsibility:

- `lib/core/` contains report state, usage normalization, pricing, aggregation,
  and rate-limit calculations.
- `lib/ingest/` contains the JSONL parser, fork/replay handling, source
  discovery, and ZIP reader.
- `lib/storage/` contains independent SQLite and ClickHouse backends plus their
  shared facade.
- `lib/report/`, `lib/web-server.js`, and `lib/cli.js` contain presentation,
  HTTP, and command-line boundaries.
- `test/*.test.js` mirrors those domains; shared fixture builders live under
  `test/support/`.

Run tests:

```bash
node --test
```

Check syntax:

```bash
node --check app.js
```
