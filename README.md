# Tokenomics Viewer

Local-first cost and token analytics for Codex and Claude Code, powered by
ClickHouse. Tokenomics reads local session logs, removes replayed parent traces
from forked Codex sessions, normalizes usage, and estimates costs from an
editable pricing catalog.

The dashboard and database run on your machine. Tokenomics does not upload
session logs or reports.

## Quick Start

Install or update Tokenomics on macOS or Linux, run the initial sync, and open
the dashboard:

```bash
/bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/skuznetsov/tokenomics-viewer/main/install.sh)"
```

Automatic setup supports arm64 and x86-64 macOS or Linux. It expects the
standard `curl`, `tar`, `sed`, `awk`, and `find` tools; installing the private
Node.js runtime also requires `shasum` or `sha256sum` for verification.

The installer does not use `sudo` or install npm packages. On the first run it:

1. Installs Tokenomics under `~/.local/share/tokenomics-viewer`.
2. Adds launchers under `~/.local/bin`.
3. Installs a private Node.js 26 runtime when the system Node.js is too old.
4. Installs `clickhousectl`, selects stable ClickHouse, and starts the named
   `tokenomics` server.
5. Imports local Codex and Claude Code sessions into ClickHouse.
6. Starts the dashboard on a loopback address and opens it in your browser.

Subsequent launches are one command:

```bash
tokenomics-launch
```

Run the one-line installer again to update Tokenomics. To install or update
without launching the application:

```bash
TOKENOMICS_NO_LAUNCH=1 /bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/skuznetsov/tokenomics-viewer/main/install.sh)"
```

If `~/.local/bin` is not on `PATH`, the installer prints the exact `export`
command to use. It does not edit shell startup files.

## What You Get

- Cost, request, and input/cache/output token totals with compact units.
- Adaptive Token Flow and Project Cost charts from daily down to 15-minute
  resolution, with pointer-centered wheel zoom, drag pan, range selection, and
  absolute or relative dates.
- Model-colored points and lines, gaps when a model was not used, and interval
  tooltips with cost, token, and share breakdowns.
- Model and effort tables with input/cache/output costs, tokens, and shares.
- `Overview` for a compact report and `Analyst` for project, model, effort, and
  resource diagnostics.
- Deterministic recommended actions with evidence, confidence, and caveats.
- An editable, database-backed provider and model pricing catalog.
- Codex rate-limit consumption summaries when snapshots are present.

Cost estimates are analytical aids, not billing statements. Subscription usage,
negotiated rates, batch pricing, and unrecognized models can differ from the
standard API-equivalent catalog.

## Common Commands

Start with ClickHouse, sync changed sessions, and open the browser:

```bash
tokenomics-launch
```

Start without opening a browser, or prefer another dashboard port:

```bash
tokenomics-launch --no-open
tokenomics-launch --port 8790
```

Limit discovery to one source. Tokenomics options follow `--`:

```bash
tokenomics-launch -- --source codex
tokenomics-launch -- --source claude
```

Serve the current ClickHouse database without scanning source files:

```bash
tokenomics --db-engine clickhouse --webserver --no-sync
```

Print a JSON report from the current ClickHouse database:

```bash
tokenomics --db-engine clickhouse --json
```

Scan explicit files or archives directly and print an in-memory report:

```bash
tokenomics /path/to/session.jsonl /path/to/archived_sessions.zip
tokenomics --json --output report.json /path/to/sessions
```

When running from a source checkout, replace `tokenomics-launch` with
`./launcher.js` and `tokenomics` with `./app.js`.

## ClickHouse

ClickHouse is the default and recommended database. The launcher normally
installs and manages it, so manual setup is not required.

The local defaults are:

| Setting | Value |
| --- | --- |
| Server name | `tokenomics` |
| HTTP endpoint | `http://127.0.0.1:8123` |
| Native TCP port | `9000` |
| Database | `tokenomics` |

### Check and Control the Local Server

```bash
chctl --version
chctl local server list
curl -fsS http://127.0.0.1:8123/ping
chctl local client --name tokenomics --query "SELECT version()"
```

Start or stop the named server:

```bash
chctl local server start --name tokenomics --http-port 8123 --tcp-port 9000
chctl local server stop tokenomics
```

`clickhousectl` stores local server state under `.clickhouse/` in the directory
where it is run. Run control commands from the same directory where you started
`tokenomics-launch`. If `chctl local server list` is unexpectedly empty, check
your current directory first.

To install `clickhousectl` manually:

```bash
curl -fsSL https://clickhouse.com/cli | sh
export PATH="$HOME/.local/bin:$PATH"
chctl local use stable
```

See the official
[`clickhousectl` getting-started guide](https://clickhouse.com/blog/getting-started-clickhousectl)
for version and local-server management details.

### Use an Existing ClickHouse Server

The low-level CLI accepts an alternate endpoint, database, and credentials:

```bash
tokenomics --sync --webserver --db-engine clickhouse \
  --clickhouse-url http://127.0.0.1:8123 \
  --clickhouse-database tokenomics \
  --clickhouse-user default
```

Credentials can also be supplied through `TOKENOMICS_CLICKHOUSE_USER` and
`TOKENOMICS_CLICKHOUSE_PASSWORD`. The endpoint and database have matching
`TOKENOMICS_CLICKHOUSE_URL` and `TOKENOMICS_CLICKHOUSE_DATABASE` variables.
Prefer environment variables to command-line passwords so credentials do not
appear in shell history or process listings.

### Batching, Compression, and Reset

ClickHouse inserts are bounded by both row count and request size: 100,000 rows
or 32 MiB by default, whichever is reached first. Tune memory and server load
with:

```bash
tokenomics --sync --db-engine clickhouse \
  --clickhouse-insert-batch-rows 50000 \
  --clickhouse-insert-batch-bytes 16MiB
```

Tokenomics uses ZSTD-based per-column codecs, plus Delta, Gorilla, or T64 where
appropriate for timestamps, counters, floats, and flags.

As a last resort, discard and rebuild every Tokenomics-owned ClickHouse table:

```bash
tokenomics --sync --db-engine clickhouse --clickhouse-reset
```

This is destructive for the selected Tokenomics database. Normal upgrades,
pricing changes, and incremental syncs do not require a reset.

## How Sync Works

With no explicit paths, Tokenomics discovers:

- `~/.claude/projects/**/*.jsonl`
- `${CODEX_HOME:-~/.codex}/sessions/**/*.{jsonl,jsonl.zst}`
- `${CODEX_HOME:-~/.codex}/archived_sessions/**/*.{jsonl,jsonl.zst,zip}`

Use `--source claude`, `--source codex`, `--archives`, or `--no-archives` to
control default discovery. ZIP and Zstandard-compressed rollouts are read
directly without extracting them. If both `.jsonl` and `.jsonl.zst` versions
exist during a compression transition, the plain file is read once.

Sync is incremental by source fingerprint. Unchanged sessions are skipped;
changed files or archive entries replace their previous normalized data. Codex
fork metadata and replay traces are used to avoid counting inherited parent
history again in subagent sessions.

ClickHouse source versions are immutable. A sync stages changed sources and a
complete source manifest, then publishes one global generation marker last.
Reports pin that generation, so a failed multi-source sync leaves the previous
complete report visible instead of exposing a partial import.

Pricing revisions are deliberately excluded from source fingerprints. Editing
a rate or adding a model updates normalized database costs without reopening
JSONL, ZIP, or Zstandard source files.

## Dashboard

The dashboard has three modes:

- `Overview` shows headline totals, recommendations, Token Flow, and a compact
  model ranking.
- `Analyst` adds per-project timelines, the full model/effort table, and Cost &
  Resource Diagnostics.
- `Settings` edits pricing and analytics configuration.

Token Flow and Project Cost load compact timeline buckets on demand. Hover
anywhere in a chart to inspect the nearest interval; use the wheel to zoom at
the pointer, drag in `Pan` mode to move through history, drag in `Zoom` mode to
select a range, and double-click to reset. Relative and absolute date controls
bound the data before interactive zooming.

The dashboard exposes these local endpoints:

- `/api/summary` for dashboard aggregates.
- `/api/timeline` for range- and project-filtered timeline data.
- `/api/report` for the complete normalized report.
- `/api/sync` and `/api/sync/events` for protected sync and live progress.

The server binds to `127.0.0.1` by default. Dashboard-triggered sync and pricing
changes are enabled only on loopback bindings. A server exposed through
`0.0.0.0` or a LAN address is intentionally read-only because Tokenomics does
not provide remote-user authentication.

## Pricing and Diagnostics

The first database open seeds a packaged pricing catalog from
`lib/core/pricing.js`. The active catalog and analytics settings then live in
the selected database.

In `Settings`, you can:

- select a `Work API` profile for estimated billed cost and an optional monthly
  USD limit, or a `Home Subscription` profile for observed quota windows and
  API-equivalent list-price economics;
- edit per-million-token input, cache-write, cache-read, and output rates;
- add providers and models;
- choose exact, prefix, or dated-snapshot model matching;
- select OpenAI short/long context pricing;
- apply a global rate multiplier.

Saves use optimistic revisions. SQLite derives new costs from normalized rows;
ClickHouse creates a compact revisioned cost overlay with one `INSERT SELECT`
and publishes the configuration marker last. Neither backend rereads session
files after a pricing-only change. Profile-name, profile-mode, and monthly-limit
changes do not alter prices, so they reuse the current pricing revision and do
not create a new ClickHouse cost overlay.

`API Cost` is the estimated billed amount for an API profile. `API Equivalent`
applies the same active catalog to subscription usage as a counterfactual value;
it is not an invoice. Subscription windows are shown only when the provider
reports them, and per-quota-point projections require near-complete pricing and
time coverage. The current frontier supports one usage profile per database;
mixed local and work sources require separate databases until source-level
profile assignment is implemented.

Custom providers can be priced only when an ingested record contains the same
provider slug. Adding a catalog row cannot infer provider identity missing from
the source log. Set the pricing basis to `custom` for negotiated, batch,
subscription, or other non-standard rates.

Diagnostics compare effort levels only inside one provider/model cohort and
within the selected model date range. They report usage-event count, tariff
coverage, estimated spend, covered input/cache/output per event, amortized spend
per output token, cache-read share, and reasoning share. A usage event is not
necessarily a user request or completed task, and tariff coverage means only
that the local catalog recognized an event. Without outcome or quality data,
Tokenomics does not rank effort levels as objectively better or worse.

GPT-5.6 Sol, Terra, and Luna support separate input, cache-write, cache-read, and
output rates. Legacy Codex `input_tokens` plus `cached_input_tokens` records are
treated as total input with cached input as a read subset. Explicit
`cache_creation_input_tokens` plus `cache_read_input_tokens` records preserve
cache writes separately. Tokenomics does not invent cache-write volume for
legacy records that cannot prove it.

The proposed compressed session store and project-scoped session viewer are not
implemented. Their intended safety boundary is documented in
[`docs/PRICING_CONFIGURATION_FRONTIER.md`](docs/PRICING_CONFIGURATION_FRONTIER.md).

## Troubleshooting

### The First Sync Takes a Long Time

The initial import must parse all discovered sessions and archives. Watch the
terminal for per-session progress. Later syncs use source fingerprints and
should skip unchanged data. Large ClickHouse inserts are streamed in bounded
batches, so increasing the Node.js heap should not be the first response to a
slow or failed import.

For a smaller diagnostic run:

```bash
tokenomics --sync --db-engine clickhouse --source codex --limit-files 20
```

### `chctl` Is Not Found

```bash
export PATH="$HOME/.local/bin:$PATH"
chctl --version
```

Add that export to your shell startup file if needed. The Tokenomics installer
prints a shell-specific suggestion but does not modify the file itself.

### ClickHouse Is Not Reachable

```bash
chctl local server list
curl -fsS http://127.0.0.1:8123/ping
```

Run both commands from the launch directory because local `clickhousectl`
servers are directory-scoped. If port `8123` belongs to another service, either
stop that service or run Tokenomics directly against another ClickHouse HTTP
endpoint with `--clickhouse-url`.

### The Dashboard Port Is Busy

The launcher tries the preferred port and the next 20 ports. Set another
starting point explicitly:

```bash
tokenomics-launch --port 8790
```

### An Installer Fails with HTML or `<!doctype`

Run the current one-line installer again. The launcher validates the
`clickhousectl` download before executing it and rejects HTML/error responses
instead of passing them to `/bin/sh`.

### Start Without Rescanning

```bash
tokenomics --db-engine clickhouse --webserver --no-sync
```

## SQLite Fallback

SQLite remains available for portability, small datasets, or environments
where running ClickHouse is not practical. ClickHouse is the tested default and
recommended path for large session histories.

Use SQLite for one launch:

```bash
tokenomics-launch --sqlite
```

Install or update and immediately opt out of ClickHouse:

```bash
/bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/skuznetsov/tokenomics-viewer/main/install.sh)" -- --sqlite
```

Or manage the SQLite database directly:

```bash
tokenomics --sync --webserver --db-engine sqlite --db tokenomics.sqlite
tokenomics --webserver --no-sync --db-engine sqlite --db tokenomics.sqlite
```

Installed-launcher SQLite data is kept across application updates at
`~/.local/share/tokenomics-viewer/tokenomics.sqlite`.

## Privacy and Data

Session logs, reports, and databases can reveal local paths, project names,
timestamps, model choices, usage patterns, and estimated spending. Keep the
dashboard on loopback and review generated output before publishing it.

The installer writes application versions beneath
`~/.local/share/tokenomics-viewer` and launchers beneath `~/.local/bin`. Local
ClickHouse server data is managed by `clickhousectl` beneath the launch
directory's `.clickhouse/` tree. SQLite files and generated reports in the
repository are ignored by `.gitignore`.

## Development

Requirements:

- Node.js 26 or newer
- No npm dependencies

Run from a source checkout:

```bash
./launcher.js
./app.js --help
```

Run the complete test suite and syntax checks:

```bash
node --test
node --check app.js
node --check launcher.js
```

The implementation is organized by responsibility:

- `lib/core/` contains report state, usage normalization, pricing,
  aggregation, and rate-limit calculations.
- `lib/ingest/` contains source discovery, JSONL parsing, archive readers, and
  fork/replay handling.
- `lib/storage/` contains the SQLite and ClickHouse backends and shared facade.
- `lib/report/`, `lib/web-server.js`, and `lib/cli.js` contain presentation,
  HTTP, and command-line boundaries.
- `test/*.test.js` mirrors those domains; shared fixtures live in
  `test/support/`.

## License

ISC. See [`LICENSE`](LICENSE).
