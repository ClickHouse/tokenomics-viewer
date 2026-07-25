"use strict";

const os = require("node:os");
const Path = require("node:path");
const { URL } = require("node:url");
const {
  DEFAULT_CLICKHOUSE_DATABASE,
  DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES,
  DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS,
  DEFAULT_CLICKHOUSE_URL,
  parseByteSize,
} = require("./storage/clickhouse");

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function defaultOptions(env = process.env) {
  return {
    source: "all",
    includeArchives: true,
    home: os.homedir(),
    codexHome: env.CODEX_HOME ? Path.resolve(env.CODEX_HOME) : null,
    ompHome: env.OMP_HOME ? Path.resolve(env.OMP_HOME) : null,
    format: "text",
    limitFiles: Number.POSITIVE_INFINITY,
    top: 25,
    openaiContext: "auto",
    strictJson: false,
    output: null,
    db: null,
    dbEngine: env.TOKENOMICS_DB_ENGINE || "sqlite",
    clickhouseUrl: env.TOKENOMICS_CLICKHOUSE_URL || DEFAULT_CLICKHOUSE_URL,
    clickhouseDatabase: env.TOKENOMICS_CLICKHOUSE_DATABASE || DEFAULT_CLICKHOUSE_DATABASE,
    clickhouseUser: env.TOKENOMICS_CLICKHOUSE_USER || "",
    clickhousePassword: env.TOKENOMICS_CLICKHOUSE_PASSWORD || "",
    clickhouseInsertBatchRows: Number(env.TOKENOMICS_CLICKHOUSE_INSERT_BATCH_ROWS || DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS),
    clickhouseInsertBatchBytes: parseByteSize(
      env.TOKENOMICS_CLICKHOUSE_INSERT_BATCH_BYTES || DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES,
      "TOKENOMICS_CLICKHOUSE_INSERT_BATCH_BYTES",
    ),
    clickhouseReset: false,
    sync: false,
    webserver: false,
    webserverSync: true,
    host: "127.0.0.1",
    port: 8787,
    progress: true,
    progressExplicit: false,
    paths: [],
  };
}

function parseArgs(argv, env = process.env) {
  const options = defaultOptions(env);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];

    if (arg === "--json") options.format = "json";
    else if (arg === "--strict-json") options.strictJson = true;
    else if (arg === "--no-archives") options.includeArchives = false;
    else if (arg === "--archives") options.includeArchives = true;
    else if (arg === "--source") options.source = next();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length);
    else if (arg === "--home") options.home = Path.resolve(next());
    else if (arg.startsWith("--home=")) options.home = Path.resolve(arg.slice("--home=".length));
    else if (arg === "--codex-home") options.codexHome = Path.resolve(next());
    else if (arg.startsWith("--codex-home=")) options.codexHome = Path.resolve(arg.slice("--codex-home=".length));
    else if (arg === "--omp-home") options.ompHome = Path.resolve(next());
    else if (arg.startsWith("--omp-home=")) options.ompHome = Path.resolve(arg.slice("--omp-home=".length));
    else if (arg === "--limit-files") options.limitFiles = Number(next());
    else if (arg.startsWith("--limit-files=")) options.limitFiles = Number(arg.slice("--limit-files=".length));
    else if (arg === "--top") options.top = Number(next());
    else if (arg.startsWith("--top=")) options.top = Number(arg.slice("--top=".length));
    else if (arg === "--format") options.format = next();
    else if (arg.startsWith("--format=")) options.format = arg.slice("--format=".length);
    else if (arg === "--output" || arg === "-o") options.output = Path.resolve(next());
    else if (arg.startsWith("--output=")) options.output = Path.resolve(arg.slice("--output=".length));
    else if (arg === "--db") options.db = Path.resolve(next());
    else if (arg.startsWith("--db=")) options.db = Path.resolve(arg.slice("--db=".length));
    else if (arg === "--db-engine") options.dbEngine = next();
    else if (arg.startsWith("--db-engine=")) options.dbEngine = arg.slice("--db-engine=".length);
    else if (arg === "--clickhouse-url") options.clickhouseUrl = next();
    else if (arg.startsWith("--clickhouse-url=")) options.clickhouseUrl = arg.slice("--clickhouse-url=".length);
    else if (arg === "--clickhouse-database") options.clickhouseDatabase = next();
    else if (arg.startsWith("--clickhouse-database=")) options.clickhouseDatabase = arg.slice("--clickhouse-database=".length);
    else if (arg === "--clickhouse-user") options.clickhouseUser = next();
    else if (arg.startsWith("--clickhouse-user=")) options.clickhouseUser = arg.slice("--clickhouse-user=".length);
    else if (arg === "--clickhouse-password") options.clickhousePassword = next();
    else if (arg.startsWith("--clickhouse-password=")) options.clickhousePassword = arg.slice("--clickhouse-password=".length);
    else if (arg === "--clickhouse-insert-batch-rows") options.clickhouseInsertBatchRows = Number(next());
    else if (arg.startsWith("--clickhouse-insert-batch-rows=")) options.clickhouseInsertBatchRows = Number(arg.slice("--clickhouse-insert-batch-rows=".length));
    else if (arg === "--clickhouse-insert-batch-bytes") options.clickhouseInsertBatchBytes = parseByteSize(next(), "--clickhouse-insert-batch-bytes");
    else if (arg.startsWith("--clickhouse-insert-batch-bytes=")) options.clickhouseInsertBatchBytes = parseByteSize(arg.slice("--clickhouse-insert-batch-bytes=".length), "--clickhouse-insert-batch-bytes");
    else if (arg === "--clickhouse-reset") options.clickhouseReset = true;
    else if (arg === "--sync") options.sync = true;
    else if (arg === "--webserver") options.webserver = true;
    else if (arg === "--host") options.host = next();
    else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--port") options.port = Number(next());
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice("--port=".length));
    else if (arg === "--no-sync") {
      options.sync = false;
      options.webserverSync = false;
    }
    else if (arg === "--no-progress") {
      options.progress = false;
      options.progressExplicit = true;
    } else if (arg === "--progress") {
      options.progress = true;
      options.progressExplicit = true;
    }
    else if (arg === "--openai-context") options.openaiContext = next();
    else if (arg.startsWith("--openai-context=")) options.openaiContext = arg.slice("--openai-context=".length);
    else if (arg === "--help" || arg === "-h") {
      return { ...options, help: true };
    } else {
      options.paths.push(arg);
    }
  }

  if (!["all", "claude", "codex", "omp"].includes(options.source)) {
    throw new Error("--source must be all, claude, codex, or omp");
  }
  if (!["auto", "short", "long"].includes(options.openaiContext)) {
    throw new Error("--openai-context must be auto, short, or long");
  }
  if (!["text", "json"].includes(options.format)) {
    throw new Error("--format must be text or json");
  }
  if (!["sqlite", "clickhouse"].includes(options.dbEngine)) {
    throw new Error("--db-engine must be sqlite or clickhouse");
  }
  try {
    new URL(options.clickhouseUrl);
  } catch {
    throw new Error("--clickhouse-url must be a valid URL");
  }
  if (!options.clickhouseDatabase || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.clickhouseDatabase)) {
    throw new Error("--clickhouse-database must be a non-empty ClickHouse identifier");
  }
  if (!Number.isInteger(options.clickhouseInsertBatchRows) || options.clickhouseInsertBatchRows <= 0) {
    throw new Error("--clickhouse-insert-batch-rows must be a positive integer");
  }
  if (!Number.isInteger(options.clickhouseInsertBatchBytes) || options.clickhouseInsertBatchBytes <= 0) {
    throw new Error("--clickhouse-insert-batch-bytes must be a positive byte size");
  }
  if (!Number.isFinite(options.top) || options.top <= 0) {
    throw new Error("--top must be a positive number");
  }
  if (Number.isNaN(options.limitFiles) || options.limitFiles <= 0) {
    throw new Error("--limit-files must be a positive number");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  if (options.output && options.format === "text") {
    const ext = Path.extname(options.output).toLowerCase();
    if (ext === ".json") options.format = "json";
  }
  if (!options.output && options.format === "json" && !options.progressExplicit) {
    options.progress = false;
  }

  return options;
}

function helpText() {
  return `Usage: node app.js [options] [paths...]

Scans Claude Code, Codex, and omp (oh-my-pi) JSONL sessions and estimates token costs.

Options:
  --source all|claude|codex|omp   Source roots to scan when paths are omitted (default: all)
  --archives / --no-archives      Include Codex archived_sessions rollouts and zip files (default: include)
  --home PATH                     Home directory for default roots (default: current user home)
  --codex-home PATH               Codex data directory (default: CODEX_HOME or ~/.codex)
  --omp-home PATH                 omp (oh-my-pi) agent data directory (default: OMP_HOME, PI_CODING_AGENT_DIR, or ~/.omp/agent)
  --openai-context auto|short|long OpenAI short/long context pricing mode (default: auto)
  --limit-files N                 Process at most N JSONL files or zip entries
  --top N                         Rows to show per section (default: 25)
  --format text|json              Final report format (default: text, or inferred from --output .json)
  -o, --output PATH               Write final report to a .txt or .json file
  --db PATH                       SQLite database path (default: ./tokenomics.sqlite for DB modes)
  --db-engine sqlite|clickhouse   Database backend for --sync/--webserver (default: sqlite)
  --clickhouse-url URL            ClickHouse HTTP endpoint (default: ${DEFAULT_CLICKHOUSE_URL})
  --clickhouse-database NAME      ClickHouse database name (default: ${DEFAULT_CLICKHOUSE_DATABASE})
  --clickhouse-user USER          ClickHouse user, or TOKENOMICS_CLICKHOUSE_USER
  --clickhouse-password PASSWORD  ClickHouse password, or TOKENOMICS_CLICKHOUSE_PASSWORD
  --clickhouse-insert-batch-rows N Max rows per ClickHouse INSERT (default: ${DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS})
  --clickhouse-insert-batch-bytes SIZE Max JSONEachRow body size per INSERT (default: ${formatBytes(DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES)})
  --clickhouse-reset              Drop tokenomics ClickHouse tables before --sync
  --sync                          Import changed sources into the selected database and report from it
  --webserver                     Serve a local browser dashboard from the selected database
  --host HOST                     Webserver host; dashboard Sync requires loopback (default: 127.0.0.1)
  --port PORT                     Webserver port (default: 8787, use 0 for a random free port)
  --no-sync                       Do not sync before --webserver
  --progress / --no-progress      Print per-session progress to stdout (default: progress on)
  --json                          Print machine-readable report JSON
  --strict-json                   Fail on malformed JSONL lines
  -h, --help                      Show this help
`;
}

function printHelp() {
  console.log(helpText());
}

module.exports = {
  defaultOptions,
  helpText,
  parseArgs,
  printHelp,
};
