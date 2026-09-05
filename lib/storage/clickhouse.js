"use strict";

const fsp = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");
const { listZipEntries } = require("../ingest/archive");
const {
  APPEND_CURSOR_VERSION,
  appendGuard,
  appendPrefixGuard,
  inspectAppendFile,
  validateAppendCursor,
} = require("../ingest/append-cursor");
const {
  MAX_VALID_OUTPUT_CHARS_PER_TOKEN,
  bucket,
  dateKey,
  monthKey,
  nestedBucket,
  newCostBreakdown,
  newReport,
  newStats,
  number,
  providerModelEffortDailyBucket,
  weekKey,
  yearKey,
} = require("../core/report-model");
const { sameSourceFingerprint, sourceFingerprint } = require("../core/derivation");
const {
  defaultConfiguration,
  LEGACY_PACKAGED_CONFIGURATION_REVISION,
  PACKAGED_CONFIGURATION_REVISION,
  isDerivedPackagedPricingRevision,
  isManagedPackagedPricingRevision,
  normalizeConfiguration,
  packagedPricingCatalogRevision,
  pricingConfigurationSignature,
  pricingOptionsFromConfiguration,
} = require("../core/configuration");
const { normalizeCodexUuid } = require("../core/usage");
const { normalizeServiceTier } = require("../core/pricing");
const { normalizeAgent, normalizeServiceMode } = require("../core/service-mode");
const { emitSyncProgress } = require("../core/sync-progress");
const { newRateLimitAttribution, newRateLimitStats } = require("../core/rate-limits");
const { CLICKHOUSE_COST_COLUMNS, buildClickHouseCostProjection } = require("./clickhouse-pricing");
const { prepareStorageInputs } = require("./source-preflight");

const DEFAULT_CLICKHOUSE_URL = "http://127.0.0.1:8123";
const DEFAULT_CLICKHOUSE_DATABASE = "tokenomics";
const DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS = 100_000;
const DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES = 32 * 1024 * 1024;
const CLICKHOUSE_MANIFEST_CHECKPOINT_INTERVAL = 128;
const CLICKHOUSE_SOURCE_TABLES = ["telemetry_events", "rate_limit_samples", "output_char_metrics", "usage_events", "sessions", "codex_sessions"];
const CLICKHOUSE_PRICING_PROJECTION_REVISION = "2";

function parseByteSize(value, flagName) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)([kmgt]?i?b?)?$/i);
  if (!match) throw new Error(`${flagName} must be a byte size, for example 33554432 or 32MiB`);

  const amount = Number(match[1]);
  const suffix = (match[2] || "").toLowerCase();
  const multipliers = {
    "": 1,
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const bytes = Math.floor(amount * multipliers[suffix]);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`${flagName} must be a positive byte size`);
  }
  return bytes;
}

function createClickHouseBackend(dependencies = {}) {
  const {
    createLimiter,
    discoverInputs,
    processJsonlFile,
    processZipEntry,
    processingOptionsWithCodexForkRegistry,
  } = dependencies;
  const formatBytes = typeof dependencies.formatBytes === "function" ? dependencies.formatBytes : String;
  const formatInt = typeof dependencies.formatInt === "function" ? dependencies.formatInt : String;
  const logProgress = typeof dependencies.logProgress === "function" ? dependencies.logProgress : () => {};
  const syncDependencyEntries = [
    ["createLimiter", createLimiter],
    ["discoverInputs", discoverInputs],
    ["processJsonlFile", processJsonlFile],
    ["processZipEntry", processZipEntry],
    ["processingOptionsWithCodexForkRegistry", processingOptionsWithCodexForkRegistry],
  ];
  function assertSyncDependencies() {
    for (const [name, dependency] of syncDependencyEntries) {
      if (typeof dependency !== "function") {
        throw new Error(`ClickHouse sync requires the ${name} ingest dependency`);
      }
    }
  }
  function clickHouseIdentifier(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) {
      throw new Error(`Invalid ClickHouse identifier: ${name}`);
    }
    return `\`${name}\``;
  }

  function clickHouseClient(options = {}) {
    const endpoint = new URL(options.clickhouseUrl || DEFAULT_CLICKHOUSE_URL);
    const userFromUrl = decodeURIComponent(endpoint.username || "");
    const passwordFromUrl = decodeURIComponent(endpoint.password || "");
    endpoint.username = "";
    endpoint.password = "";
    return {
      url: endpoint.toString(),
      database: options.clickhouseDatabase || DEFAULT_CLICKHOUSE_DATABASE,
      user: options.clickhouseUser || userFromUrl,
      password: options.clickhousePassword || passwordFromUrl,
    };
  }

  function clickHouseLabel(client) {
    const endpoint = new URL(client.url);
    return `${endpoint.origin}/${client.database}`;
  }

  async function clickHouseRequest(client, query, { body = null, database = true, params = {}, settings = {} } = {}) {
    const url = new URL(client.url);
    if (database && client.database) url.searchParams.set("database", client.database);
    let requestBody = body;
    if (body === null && Buffer.byteLength(query) > 8 * 1024) {
      requestBody = query;
    } else {
      url.searchParams.set("query", query);
    }
    url.searchParams.set("output_format_json_quote_64bit_integers", "0");
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(`param_${key}`, String(value ?? ""));
    }
    for (const [key, value] of Object.entries(settings)) {
      url.searchParams.set(key, String(value));
    }

    const headers = {};
    if (requestBody !== null) headers["content-type"] = "text/plain; charset=utf-8";
    if (client.user || client.password) {
      headers.authorization = `Basic ${Buffer.from(`${client.user}:${client.password}`).toString("base64")}`;
    }

    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body: requestBody });
    } catch (error) {
      const cause = error.cause?.message ? ` (${error.cause.message})` : "";
      throw new Error(`Cannot connect to ClickHouse at ${url.origin}. Start it with \`chctl local server start\`, or pass --clickhouse-url. ${error.message}${cause}`);
    }
    const text = await response.text();
    if (!response.ok) {
      const message = text.trim() || response.statusText;
      throw new Error(`ClickHouse query failed (${response.status}): ${message}`);
    }
    return text;
  }

  async function clickHouseJsonEachRow(client, query, options) {
    const text = await clickHouseRequest(client, `${query}\nFORMAT JSONEachRow`, options);
    return text.trim()
      ? text.trim().split("\n").map((line) => JSON.parse(line))
      : [];
  }

  async function initializeClickHouseDatabase(client) {
    await clickHouseRequest(
      client,
      `CREATE DATABASE IF NOT EXISTS ${clickHouseIdentifier(client.database)}`,
      { database: false },
    );
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS sources (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        kind LowCardinality(String) CODEC(ZSTD(1)),
        archive_path String CODEC(ZSTD(3)),
        entry_name String CODEC(ZSTD(3)),
        fingerprint String CODEC(ZSTD(3)),
        size_bytes UInt64 CODEC(Delta, ZSTD(1)),
        compressed_size_bytes UInt64 CODEC(Delta, ZSTD(1)),
        imported_at String CODEC(ZSTD(1)),
        cursor_version UInt64 CODEC(T64, ZSTD(1)),
        segment_start UInt64 CODEC(Delta, ZSTD(1)),
        segment_end UInt64 CODEC(Delta, ZSTD(1)),
        cursor_line UInt64 CODEC(Delta, ZSTD(1)),
        cursor_guard String CODEC(ZSTD(1)),
        cursor_prefix_guard String CODEC(ZSTD(1)),
        parser_checkpoint String CODEC(ZSTD(6)),
        file_device String CODEC(ZSTD(1)),
        file_inode String CODEC(ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY source_path
    `);
    await clickHouseRequest(client, `
      ALTER TABLE sources
        ADD COLUMN IF NOT EXISTS cursor_version UInt64 DEFAULT 0 CODEC(T64, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS segment_start UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS segment_end UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS cursor_line UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS cursor_guard String DEFAULT '' CODEC(ZSTD(1)),
        ADD COLUMN IF NOT EXISTS cursor_prefix_guard String DEFAULT '' CODEC(ZSTD(1)),
        ADD COLUMN IF NOT EXISTS parser_checkpoint String DEFAULT '' CODEC(ZSTD(6)),
        ADD COLUMN IF NOT EXISTS file_device String DEFAULT '' CODEC(ZSTD(1)),
        ADD COLUMN IF NOT EXISTS file_inode String DEFAULT '' CODEC(ZSTD(1))
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS codex_sessions (
        session_id String CODEC(ZSTD(3)),
        parent_session_id String CODEC(ZSTD(3)),
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        kind LowCardinality(String) CODEC(ZSTD(1)),
        archive_path String CODEC(ZSTD(3)),
        entry_name String CODEC(ZSTD(3)),
        segment_end UInt64 CODEC(Delta, ZSTD(1)),
        updated_at_ms UInt64 CODEC(Delta, ZSTD(1))
      ) ENGINE = ReplacingMergeTree(updated_at_ms)
      ORDER BY session_id
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS codex_session_versions (
        session_id String CODEC(ZSTD(3)),
        parent_session_id String CODEC(ZSTD(3)),
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        kind LowCardinality(String) CODEC(ZSTD(1)),
        archive_path String CODEC(ZSTD(3)),
        entry_name String CODEC(ZSTD(3)),
        segment_end UInt64 CODEC(Delta, ZSTD(1)),
        updated_at_ms UInt64 CODEC(Delta, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (session_id, source_path, import_id, updated_at_ms)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS sessions (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        kind LowCardinality(String) CODEC(ZSTD(1)),
        archive_path String CODEC(ZSTD(3)),
        entry_name String CODEC(ZSTD(3)),
        size_bytes UInt64 CODEC(Delta, ZSTD(1)),
        compressed_size_bytes UInt64 CODEC(Delta, ZSTD(1)),
        started_at String CODEC(ZSTD(1)),
        finished_at String CODEC(ZSTD(1)),
        duration_ms Float64 CODEC(Gorilla, ZSTD(1)),
        lines UInt64 CODEC(Delta, ZSTD(1)),
        records UInt64 CODEC(Delta, ZSTD(1)),
        parse_errors UInt64 CODEC(Delta, ZSTD(1)),
        token_count_snapshots UInt64 CODEC(Delta, ZSTD(1)),
        skipped_token_count_snapshots UInt64 CODEC(Delta, ZSTD(1)),
        segment_start UInt64 CODEC(Delta, ZSTD(1)),
        segment_end UInt64 CODEC(Delta, ZSTD(1)),
        stats_json String CODEC(ZSTD(6))
      ) ENGINE = MergeTree
      ORDER BY source_path
    `);
    await clickHouseRequest(client, `
      ALTER TABLE sessions
        ADD COLUMN IF NOT EXISTS segment_start UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS segment_end UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1))
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS usage_events (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        segment_end UInt64 CODEC(Delta, ZSTD(1)),
        line_no UInt64 CODEC(Delta, ZSTD(1)),
        event_key String CODEC(ZSTD(3)),
        timestamp Nullable(String) CODEC(ZSTD(1)),
        date_key String CODEC(ZSTD(1)),
        week_key String CODEC(ZSTD(1)),
        month_key String CODEC(ZSTD(1)),
        year_key String CODEC(ZSTD(1)),
        provider LowCardinality(String) CODEC(ZSTD(1)),
        model String CODEC(ZSTD(3)),
        project String CODEC(ZSTD(3)),
        effort LowCardinality(String) CODEC(ZSTD(1)),
        service_tier LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
        service_mode LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
        agent LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
        input UInt64 CODEC(Delta, ZSTD(1)),
        cache_create_5m UInt64 CODEC(Delta, ZSTD(1)),
        cache_create_30m UInt64 CODEC(Delta, ZSTD(1)),
        cache_create_1h UInt64 CODEC(Delta, ZSTD(1)),
        cache_read UInt64 CODEC(Delta, ZSTD(1)),
        output UInt64 CODEC(Delta, ZSTD(1)),
        reasoning_output UInt64 CODEC(Delta, ZSTD(1)),
        context_window UInt64 CODEC(Delta, ZSTD(1)),
        priced UInt8 CODEC(T64, ZSTD(1)),
        cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
        reasoning_cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_input_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_create_5m_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_create_30m_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_create_1h_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_read_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_output_usd Float64 CODEC(Gorilla, ZSTD(1)),
        visible_input_chars UInt64 CODEC(Delta, ZSTD(1)),
        visible_output_chars UInt64 CODEC(Delta, ZSTD(1)),
        visible_total_chars UInt64 CODEC(Delta, ZSTD(1)),
        visible_chars_per_token Float64 CODEC(Gorilla, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (date_key, source_path, line_no)
    `);
    await clickHouseRequest(client, `
      ALTER TABLE usage_events
        ADD COLUMN IF NOT EXISTS import_id String DEFAULT '' CODEC(ZSTD(3)),
        ADD COLUMN IF NOT EXISTS segment_end UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS event_key String DEFAULT '' CODEC(ZSTD(3)),
        ADD COLUMN IF NOT EXISTS service_tier LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
        ADD COLUMN IF NOT EXISTS service_mode LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
        ADD COLUMN IF NOT EXISTS agent LowCardinality(String) DEFAULT 'unknown' CODEC(ZSTD(1)),
        ADD COLUMN IF NOT EXISTS cache_create_30m UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS cost_cache_create_30m_usd Float64 DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS visible_input_chars UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS visible_output_chars UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS visible_total_chars UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS visible_chars_per_token Float64 DEFAULT 0 CODEC(Gorilla, ZSTD(1))
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS output_char_metrics (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        turn_id String CODEC(ZSTD(3)),
        turn_key String CODEC(ZSTD(3)),
        metric_revision UInt64 CODEC(Delta, ZSTD(1)),
        timestamp Nullable(String) CODEC(ZSTD(1)),
        date_key String CODEC(ZSTD(1)),
        week_key String CODEC(ZSTD(1)),
        month_key String CODEC(ZSTD(1)),
        year_key String CODEC(ZSTD(1)),
        provider LowCardinality(String) CODEC(ZSTD(1)),
        model String CODEC(ZSTD(3)),
        project String CODEC(ZSTD(3)),
        effort LowCardinality(String) CODEC(ZSTD(1)),
        visible_output_chars UInt64 CODEC(Delta, ZSTD(1)),
        visible_output_tokens UInt64 CODEC(Delta, ZSTD(1)),
        output_chars_per_token Float64 CODEC(Gorilla, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (date_key, source_path, turn_id)
    `);
    await clickHouseRequest(client, `
      ALTER TABLE output_char_metrics
        ADD COLUMN IF NOT EXISTS turn_key String DEFAULT '' CODEC(ZSTD(3)),
        ADD COLUMN IF NOT EXISTS metric_revision UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1))
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS rate_limit_samples (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        segment_end UInt64 CODEC(Delta, ZSTD(1)),
        line_no UInt64 CODEC(Delta, ZSTD(1)),
        sample_key String CODEC(ZSTD(3)),
        group_key String CODEC(ZSTD(3)),
        sequence UInt64 CODEC(Delta, ZSTD(1)),
        timestamp_ms UInt64 CODEC(Delta, ZSTD(1)),
        date_key String CODEC(ZSTD(1)),
        week_key String CODEC(ZSTD(1)),
        limit_id Nullable(String) CODEC(ZSTD(3)),
        limit_name Nullable(String) CODEC(ZSTD(3)),
        plan_type Nullable(String) CODEC(ZSTD(1)),
        kind LowCardinality(String) CODEC(ZSTD(1)),
        window_minutes UInt64 CODEC(Delta, ZSTD(1)),
        used_percent Float64 CODEC(Gorilla, ZSTD(1)),
        resets_at UInt64 CODEC(Delta, ZSTD(1)),
        reached UInt8 CODEC(T64, ZSTD(1)),
        agent LowCardinality(String) CODEC(ZSTD(1)),
        effort LowCardinality(String) CODEC(ZSTD(1)),
        model String CODEC(ZSTD(3)),
        input UInt64 CODEC(Delta, ZSTD(1)),
        cache_read UInt64 CODEC(Delta, ZSTD(1)),
        output UInt64 CODEC(Delta, ZSTD(1)),
        reasoning_output UInt64 CODEC(Delta, ZSTD(1)),
        priced UInt8 CODEC(T64, ZSTD(1)),
        cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
        reasoning_cost_usd Float64 CODEC(Gorilla, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (group_key, timestamp_ms, sequence, source_path, line_no)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS telemetry_events (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        segment_end UInt64 CODEC(Delta, ZSTD(1)),
        line_no UInt64 CODEC(Delta, ZSTD(1)),
        timestamp String CODEC(ZSTD(1)),
        timestamp_ms UInt64 CODEC(Delta, ZSTD(1)),
        date_key String CODEC(ZSTD(1)),
        provider LowCardinality(String) CODEC(ZSTD(1)),
        agent LowCardinality(String) CODEC(ZSTD(1)),
        model String CODEC(ZSTD(3)),
        project String CODEC(ZSTD(3)),
        event_kind LowCardinality(String) CODEC(ZSTD(1)),
        raw_json String CODEC(ZSTD(6))
      ) ENGINE = MergeTree
      ORDER BY (provider, timestamp_ms, source_path, line_no)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS import_generation_sources (
        generation_id String CODEC(ZSTD(3)),
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        committed_segment_end Nullable(UInt64) CODEC(ZSTD(1)),
        deleted UInt8 CODEC(T64, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (generation_id, source_path)
    `);
    await clickHouseRequest(client, `
      ALTER TABLE import_generation_sources
        ADD COLUMN IF NOT EXISTS committed_segment_end Nullable(UInt64) DEFAULT NULL CODEC(ZSTD(1)),
        ADD COLUMN IF NOT EXISTS deleted UInt8 DEFAULT 0 CODEC(T64, ZSTD(1))
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS import_generation_source_deltas (
        committed_at_ms UInt64 CODEC(Delta, ZSTD(1)),
        generation_id String CODEC(ZSTD(3)),
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        committed_segment_end Nullable(UInt64) CODEC(ZSTD(1)),
        deleted UInt8 CODEC(T64, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (committed_at_ms, generation_id, source_path)
    `);
    for (const table of ["codex_sessions", "codex_session_versions", "rate_limit_samples", "telemetry_events"]) {
      await clickHouseRequest(client, `
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS segment_end UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1))
      `);
    }
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS import_generations (
        generation_id String CODEC(ZSTD(3)),
        committed_at_ms UInt64 CODEC(Delta, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (committed_at_ms, generation_id)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS import_generation_checkpoints (
        committed_at_ms UInt64 CODEC(Delta, ZSTD(1)),
        generation_id String CODEC(ZSTD(3)),
        base_committed_at_ms UInt64 CODEC(Delta, ZSTD(1)),
        base_generation_id String CODEC(ZSTD(3))
      ) ENGINE = MergeTree
      ORDER BY (committed_at_ms, generation_id)
    `);
    await clickHouseRequest(client, `
      ALTER TABLE import_generation_checkpoints
        ADD COLUMN IF NOT EXISTS committed_at_ms UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS base_committed_at_ms UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
        ADD COLUMN IF NOT EXISTS base_generation_id String DEFAULT '' CODEC(ZSTD(3))
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS configuration_revisions (
        revision String CODEC(ZSTD(3)),
        parent_revision String CODEC(ZSTD(3)),
        committed_at_ms UInt64 CODEC(Delta, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (committed_at_ms, revision)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS configuration_metadata (
        revision String CODEC(ZSTD(3)),
        written_at_ms UInt64 CODEC(Delta, ZSTD(1)),
        managed_pricing UInt8 CODEC(T64, ZSTD(1)),
        packaged_revision String CODEC(ZSTD(1)),
        pricing_projection_revision String CODEC(ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (revision, written_at_ms)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS analytics_settings (
        revision String CODEC(ZSTD(3)),
        key LowCardinality(String) CODEC(ZSTD(1)),
        value_json String CODEC(ZSTD(3))
      ) ENGINE = MergeTree
      ORDER BY (revision, key)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS pricing_catalog (
        revision String CODEC(ZSTD(3)),
        row_id String CODEC(ZSTD(3)),
        provider LowCardinality(String) CODEC(ZSTD(1)),
        model String CODEC(ZSTD(3)),
        match_mode LowCardinality(String) CODEC(ZSTD(1)),
        variant LowCardinality(String) CODEC(ZSTD(1)),
        effective_from String CODEC(ZSTD(1)),
        effective_until String CODEC(ZSTD(1)),
        input Float64 CODEC(Gorilla, ZSTD(1)),
        cache_create_5m Nullable(Float64) CODEC(Gorilla, ZSTD(1)),
        cache_create_30m Nullable(Float64) CODEC(Gorilla, ZSTD(1)),
        cache_create_1h Nullable(Float64) CODEC(Gorilla, ZSTD(1)),
        cache_read Nullable(Float64) CODEC(Gorilla, ZSTD(1)),
        output Float64 CODEC(Gorilla, ZSTD(1)),
        source_url String CODEC(ZSTD(3))
      ) ENGINE = MergeTree
      ORDER BY (revision, provider, model, variant, row_id)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS usage_event_costs (
        pricing_revision String CODEC(ZSTD(3)),
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        line_no UInt64 CODEC(Delta, ZSTD(1)),
        priced UInt8 CODEC(T64, ZSTD(1)),
        cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
        reasoning_cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_input_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_create_5m_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_create_30m_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_create_1h_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_cache_read_usd Float64 CODEC(Gorilla, ZSTD(1)),
        cost_output_usd Float64 CODEC(Gorilla, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (pricing_revision, source_path, import_id, line_no)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS rate_limit_sample_costs (
        pricing_revision String CODEC(ZSTD(3)),
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        line_no UInt64 CODEC(Delta, ZSTD(1)),
        sample_key String CODEC(ZSTD(3)),
        sequence UInt64 CODEC(Delta, ZSTD(1)),
        priced UInt8 CODEC(T64, ZSTD(1)),
        cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
        reasoning_cost_usd Float64 CODEC(Gorilla, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (pricing_revision, source_path, import_id, line_no, sample_key, sequence)
    `);
    await clickHouseRequest(client, `
      ALTER TABLE sources
        ADD COLUMN IF NOT EXISTS import_id String DEFAULT '' CODEC(ZSTD(3))
    `);
    for (const table of ["codex_sessions", "sessions", "output_char_metrics", "rate_limit_samples", "telemetry_events"]) {
      await clickHouseRequest(client, `
        ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS import_id String DEFAULT '' CODEC(ZSTD(3))
      `);
    }
  }

  async function resetClickHouseTables(client) {
    await clickHouseRequest(
      client,
      `CREATE DATABASE IF NOT EXISTS ${clickHouseIdentifier(client.database)}`,
      { database: false },
    );
    for (const table of ["current_rate_limit_samples", "current_output_char_metrics", "current_usage_events", "current_sessions", "current_codex_sessions", "current_sources"]) {
      await clickHouseRequest(client, `DROP VIEW IF EXISTS ${table}`);
    }
    for (const table of [
      "import_generations",
      "import_generation_sources",
      "import_generation_source_deltas",
      "import_generation_checkpoints",
      "configuration_revisions",
      "configuration_metadata",
      "analytics_settings",
      "pricing_catalog",
      "usage_event_costs",
      "rate_limit_sample_costs",
      "codex_session_versions",
      ...CLICKHOUSE_SOURCE_TABLES,
      "sources",
    ]) {
      await clickHouseRequest(client, `DROP TABLE IF EXISTS ${table}`);
    }
  }

  function clickHouseSourceRow(source, fingerprint, importId) {
    return {
      source_path: source.path,
      import_id: importId,
      kind: source.kind,
      archive_path: source.archivePath || "",
      entry_name: source.entryName || "",
      fingerprint,
      size_bytes: number(source.sizeBytes),
      compressed_size_bytes: number(source.compressedSizeBytes),
      imported_at: new Date().toISOString(),
      cursor_version: number(source.cursorVersion),
      segment_start: number(source.segmentStart),
      segment_end: number(source.segmentEnd),
      cursor_line: number(source.cursorLine),
      cursor_guard: source.cursorGuard || "",
      cursor_prefix_guard: source.cursorPrefixGuard || "",
      parser_checkpoint: source.parserCheckpoint ? JSON.stringify(source.parserCheckpoint) : "",
      file_device: source.fileDevice || "",
      file_inode: source.fileInode || "",
    };
  }

  async function latestClickHouseGeneration(client) {
    const rows = await clickHouseJsonEachRow(client, `
      SELECT generation_id, committed_at_ms
      FROM import_generations
      ORDER BY committed_at_ms DESC, generation_id DESC
      LIMIT 1
    `);
    return rows[0] || null;
  }

  async function latestClickHouseConfigurationRevision(client) {
    const rows = await clickHouseJsonEachRow(client, `
      SELECT revision, parent_revision, committed_at_ms
      FROM configuration_revisions
      ORDER BY committed_at_ms DESC, revision DESC
      LIMIT 1
    `);
    return rows[0] || null;
  }

  function clickHousePricingRow(row) {
    return {
      id: row.row_id,
      provider: row.provider,
      model: row.model,
      matchMode: row.match_mode,
      variant: row.variant,
      effectiveFrom: row.effective_from || null,
      effectiveUntil: row.effective_until || null,
      input: row.input,
      cacheCreate5m: row.cache_create_5m,
      cacheCreate30m: row.cache_create_30m,
      cacheCreate1h: row.cache_create_1h,
      cacheRead: row.cache_read,
      output: row.output,
      sourceUrl: row.source_url,
    };
  }

  async function clickHouseConfigurationSourceAtRevision(client, revision) {
    const settingsRows = await clickHouseJsonEachRow(client, `
      SELECT DISTINCT key, value_json
      FROM analytics_settings
      WHERE revision = {revision:String}
      ORDER BY key
    `, { params: { revision } });
    const priceRows = await clickHouseJsonEachRow(client, `
      SELECT DISTINCT *
      FROM pricing_catalog
      WHERE revision = {revision:String}
      ORDER BY provider, model, variant, row_id
    `, { params: { revision } });
    const metadataRows = await clickHouseJsonEachRow(client, `
      SELECT managed_pricing, packaged_revision, pricing_projection_revision
      FROM configuration_metadata
      WHERE revision = {revision:String}
      ORDER BY written_at_ms DESC
      LIMIT 1
    `, { params: { revision } });
    const metadata = metadataRows[0] || {};
    return {
      revision,
      settings: Object.fromEntries(settingsRows.map((row) => [row.key, JSON.parse(row.value_json)])),
      prices: priceRows.map(clickHousePricingRow),
      clickHouseMetadata: {
        managedPricing: number(metadata.managed_pricing) === 1,
        packagedRevision: String(metadata.packaged_revision || ""),
        pricingProjectionRevision: String(metadata.pricing_projection_revision || ""),
      },
    };
  }

  async function configurationAtClickHouseRevision(client, revision) {
    return normalizeConfiguration(await clickHouseConfigurationSourceAtRevision(client, revision));
  }

  async function insertClickHouseConfigurationData(client, configuration, options = {}, metadata = {}) {
    const normalized = normalizeConfiguration(configuration);
    const managedPricing = metadata.managedPricing ?? /^packaged-\d+$/.test(normalized.settings.pricingRevision);
    await clickHouseInsertRows(client, "configuration_metadata", [{
      revision: normalized.revision,
      written_at_ms: Date.now(),
      managed_pricing: managedPricing ? 1 : 0,
      packaged_revision: managedPricing
        ? String(metadata.packagedRevision || PACKAGED_CONFIGURATION_REVISION)
        : "",
      pricing_projection_revision: String(
        metadata.pricingProjectionRevision || CLICKHOUSE_PRICING_PROJECTION_REVISION,
      ),
    }], options);
    await clickHouseInsertRows(client, "analytics_settings", Object.entries(normalized.settings).map(([key, value]) => ({
      revision: normalized.revision,
      key,
      value_json: JSON.stringify(value),
    })), options);
    await clickHouseInsertRows(client, "pricing_catalog", normalized.prices.map((row) => ({
      revision: normalized.revision,
      row_id: row.id,
      provider: row.provider,
      model: row.model,
      match_mode: row.matchMode,
      variant: row.variant,
      effective_from: row.effectiveFrom || "",
      effective_until: row.effectiveUntil || "",
      input: row.input,
      cache_create_5m: row.cacheCreate5m,
      cache_create_30m: row.cacheCreate30m,
      cache_create_1h: row.cacheCreate1h,
      cache_read: row.cacheRead,
      output: row.output,
      source_url: row.sourceUrl,
    })), options);
    return normalized;
  }

  async function commitClickHouseConfiguration(client, configuration, parentRevision = "", previousCommitMs = 0, options = {}) {
    const committedAtMs = Math.max(Date.now(), number(previousCommitMs) + 1);
    await clickHouseInsertRows(client, "configuration_revisions", [{
      revision: configuration.revision,
      parent_revision: parentRevision || "",
      committed_at_ms: committedAtMs,
    }], options);
    return configuration;
  }

  async function insertClickHouseConfiguration(client, configuration, parentRevision = "", previousCommitMs = 0, options = {}) {
    const normalized = await insertClickHouseConfigurationData(client, configuration, options);
    return commitClickHouseConfiguration(client, normalized, parentRevision, previousCommitMs, options);
  }

  async function ensureClickHouseConfiguration(client, options = {}) {
    const current = await latestClickHouseConfigurationRevision(client);
    if (!current) return insertClickHouseConfiguration(client, defaultConfiguration(), "", 0, options);

    const source = await clickHouseConfigurationSourceAtRevision(client, current.revision);
    const storedPricingRevision = String(
      source.settings?.pricingRevision || source.revision || "",
    ).trim();
    const currentPackagedVersion = Number(PACKAGED_CONFIGURATION_REVISION.replace("packaged-", ""));
    const storedPublicPackagedMatch = storedPricingRevision.match(
      /^packaged-(\d+)(?::(?:managed:)?[0-9a-f]{32})?$/,
    );
    if (source.settings?.pricingBasis === "standard" && storedPublicPackagedMatch &&
        Number(storedPublicPackagedMatch[1]) > currentPackagedVersion) {
      throw new Error(
        `stored packaged pricing revision ${storedPricingRevision} is newer than ${PACKAGED_CONFIGURATION_REVISION}`,
      );
    }
    const inferredPackagedRevision = source.settings?.pricingBasis === "standard" &&
      isDerivedPackagedPricingRevision(storedPricingRevision)
      ? packagedPricingCatalogRevision(source.prices)
      : "";
    const legacyManagedPricing = inferredPackagedRevision === LEGACY_PACKAGED_CONFIGURATION_REVISION;
    const metadataManagedPricing = source.clickHouseMetadata.managedPricing;
    const storedPackagedMatch = source.clickHouseMetadata.packagedRevision.match(/^packaged-(\d+)$/);
    if (metadataManagedPricing && storedPackagedMatch && Number(storedPackagedMatch[1]) > currentPackagedVersion) {
      throw new Error(
        `ClickHouse packaged pricing revision ${source.clickHouseMetadata.packagedRevision} is newer than ${PACKAGED_CONFIGURATION_REVISION}`,
      );
    }
    const packagedMetadataStale = metadataManagedPricing &&
      source.clickHouseMetadata.packagedRevision !== PACKAGED_CONFIGURATION_REVISION;
    const inferredPackagedStale = inferredPackagedRevision &&
      inferredPackagedRevision !== PACKAGED_CONFIGURATION_REVISION;
    let normalizationSource = source;
    if (legacyManagedPricing) {
      normalizationSource = {
        ...source,
        settings: {
          ...source.settings,
          pricingRevision: LEGACY_PACKAGED_CONFIGURATION_REVISION,
        },
      };
    } else if (packagedMetadataStale) {
      normalizationSource = {
        ...source,
        settings: {
          ...source.settings,
          pricingRevision: source.clickHouseMetadata.packagedRevision || PACKAGED_CONFIGURATION_REVISION,
        },
      };
    } else if (inferredPackagedStale) {
      normalizationSource = {
        ...source,
        settings: {
          ...source.settings,
          pricingRevision: inferredPackagedRevision,
        },
      };
    }
    const configuration = normalizeConfiguration(normalizationSource);
    const managedPricing = metadataManagedPricing || Boolean(inferredPackagedRevision) ||
      isManagedPackagedPricingRevision(storedPricingRevision) ||
      /^packaged-\d+$/.test(storedPricingRevision);
    const storedProjectionRevision = source.clickHouseMetadata.pricingProjectionRevision;
    const storedProjectionNumber = /^\d+$/.test(storedProjectionRevision)
      ? Number(storedProjectionRevision)
      : null;
    if (storedProjectionNumber !== null && storedProjectionNumber > Number(CLICKHOUSE_PRICING_PROJECTION_REVISION)) {
      throw new Error(
        `ClickHouse pricing projection revision ${storedProjectionRevision} is newer than ${CLICKHOUSE_PRICING_PROJECTION_REVISION}`,
      );
    }
    const projectionStale = storedProjectionRevision !== CLICKHOUSE_PRICING_PROJECTION_REVISION;
    if (storedPricingRevision === configuration.settings.pricingRevision && !projectionStale) return configuration;

    // A catalog or ClickHouse projection revision changed. Publish the
    // normalized catalog and its repricing overlays under a fresh append-only
    // configuration revision, then expose the marker last. This makes pricing
    // changes visible for already-imported usage without reopening transcripts.
    const upgradeRevision = randomUUID();
    const upgraded = normalizeConfiguration({
      ...configuration,
      revision: upgradeRevision,
      settings: {
        ...configuration.settings,
        // Derive a unique pricing revision for this append-only migration.
        // Retries and concurrent starters then write disjoint overlay keys.
        // Preserve managed provenance without claiming derived catalogs are
        // safe to replace during a later packaged upgrade.
        pricingRevision: upgradeRevision,
      },
    });
    await insertClickHouseConfigurationData(client, upgraded, options, {
      managedPricing,
      packagedRevision: managedPricing ? PACKAGED_CONFIGURATION_REVISION : "",
    });
    const generation = await ensureClickHouseBaselineGeneration(client, options);
    await insertClickHousePricingOverlays(client, upgraded, generation?.generation_id || "");
    return commitClickHouseConfiguration(
      client,
      upgraded,
      current.revision,
      current.committed_at_ms,
      options,
    );
  }

  async function loadClickHouseConfiguration(options = {}) {
    const client = clickHouseClient(options);
    await initializeClickHouseDatabase(client);
    return ensureClickHouseConfiguration(client, options);
  }

  async function saveClickHouseConfiguration(options = {}, source = {}) {
    const candidate = normalizeConfiguration(source);
    const client = clickHouseClient(options);
    await initializeClickHouseDatabase(client);
    await ensureClickHouseConfiguration(client, options);
    const current = await latestClickHouseConfigurationRevision(client);
    if (!current || current.revision !== candidate.revision) {
      const error = new Error("configuration revision conflict");
      error.statusCode = 409;
      throw error;
    }
    const currentSource = await clickHouseConfigurationSourceAtRevision(client, current.revision);
    const currentConfiguration = normalizeConfiguration(currentSource);
    const nextRevision = randomUUID();
    const pricingChanged = pricingConfigurationSignature(currentConfiguration) !== pricingConfigurationSignature(candidate);
    const next = normalizeConfiguration({
      ...candidate,
      revision: nextRevision,
      settings: {
        ...candidate.settings,
        pricingRevision: pricingChanged ? nextRevision : currentConfiguration.settings.pricingRevision,
      },
    });
    await insertClickHouseConfigurationData(client, next, options, {
      managedPricing: !pricingChanged && currentSource.clickHouseMetadata.managedPricing,
      packagedRevision: !pricingChanged ? currentSource.clickHouseMetadata.packagedRevision : "",
    });
    if (pricingChanged) {
      const generation = await ensureClickHouseBaselineGeneration(client, options);
      await insertClickHousePricingOverlays(client, next, generation?.generation_id || "");
    }
    return commitClickHouseConfiguration(client, next, current.revision, current.committed_at_ms, options);
  }

  function clickHouseActiveManifestDefinitions() {
    return `
      target_generation AS (
        SELECT generation_id, committed_at_ms
        FROM import_generations
        WHERE generation_id = {generation:String}
        LIMIT 1
      ),
      ordered_generations AS (
        SELECT
          source.generation_id AS generation_id,
          source.committed_at_ms AS committed_at_ms,
          lagInFrame(source.generation_id, 1, '') OVER (
            ORDER BY source.committed_at_ms, source.generation_id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS previous_generation_id,
          lagInFrame(source.committed_at_ms, 1, toUInt64(0)) OVER (
            ORDER BY source.committed_at_ms, source.generation_id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS previous_committed_at_ms
        FROM import_generations AS source
        CROSS JOIN target_generation AS target
        WHERE tuple(source.committed_at_ms, source.generation_id)
          <= tuple(target.committed_at_ms, target.generation_id)
      ),
      valid_checkpoints AS (
        SELECT
          committed.generation_id AS generation_id,
          committed.committed_at_ms AS committed_at_ms
        FROM import_generation_checkpoints AS checkpoint
        INNER JOIN ordered_generations AS committed USING (generation_id)
        WHERE (
          checkpoint.base_generation_id = committed.previous_generation_id
          AND checkpoint.base_committed_at_ms = committed.previous_committed_at_ms
        ) OR checkpoint.base_generation_id = checkpoint.generation_id
      ),
      checkpoint_boundary AS (
        SELECT if(
          count() = 0,
          tuple(toUInt64(0), ''),
          max(tuple(committed_at_ms, generation_id))
        ) AS boundary
        FROM valid_checkpoints
      ),
      checkpoint_snapshot AS (
        SELECT
          manifest.source_path AS source_path,
          manifest.import_id AS import_id,
          manifest.committed_segment_end AS committed_segment_end,
          manifest.deleted AS deleted,
          committed.generation_id AS generation_id,
          committed.committed_at_ms AS committed_at_ms
        FROM import_generation_sources AS manifest
        INNER JOIN import_generations AS committed USING (generation_id)
        CROSS JOIN checkpoint_boundary AS checkpoint
        WHERE checkpoint.boundary.2 != ''
          AND manifest.generation_id = checkpoint.boundary.2
      ),
      legacy_snapshot AS (
        SELECT
          manifest.source_path AS source_path,
          manifest.import_id AS import_id,
          manifest.committed_segment_end AS committed_segment_end,
          manifest.deleted AS deleted,
          committed.generation_id AS generation_id,
          committed.committed_at_ms AS committed_at_ms
        FROM import_generation_sources AS manifest
        INNER JOIN import_generations AS committed USING (generation_id)
        CROSS JOIN target_generation AS target
        CROSS JOIN checkpoint_boundary AS checkpoint
        WHERE checkpoint.boundary.2 = ''
          AND manifest.generation_id = target.generation_id
      ),
      manifest_deltas AS (
        SELECT
          manifest.source_path AS source_path,
          manifest.import_id AS import_id,
          manifest.committed_segment_end AS committed_segment_end,
          manifest.deleted AS deleted,
          committed.generation_id AS generation_id,
          committed.committed_at_ms AS committed_at_ms
        FROM import_generation_source_deltas AS manifest
        INNER JOIN import_generations AS committed USING (generation_id)
        CROSS JOIN target_generation AS target
        CROSS JOIN checkpoint_boundary AS checkpoint
        WHERE tuple(manifest.committed_at_ms, manifest.generation_id) > checkpoint.boundary
          AND tuple(manifest.committed_at_ms, manifest.generation_id)
            <= tuple(target.committed_at_ms, target.generation_id)
      ),
      manifest_history AS (
        SELECT * FROM checkpoint_snapshot
        UNION ALL
        SELECT * FROM legacy_snapshot
        UNION ALL
        SELECT * FROM manifest_deltas
      ),
      manifest_heads AS (
        SELECT
          source_path,
          argMax(generation_id, tuple(committed_at_ms, generation_id)) AS generation_id
        FROM manifest_history
        GROUP BY source_path
      ),
      manifest_watermarks AS (
        SELECT
          source_path,
          import_id,
          max(committed_segment_end) AS committed_segment_end
        FROM manifest_history
        WHERE deleted = 0
        GROUP BY source_path, import_id
      ),
      active_manifest AS (
        SELECT
          history.source_path AS source_path,
          history.import_id AS import_id,
          watermarks.committed_segment_end AS committed_segment_end
        FROM manifest_history AS history
        INNER JOIN manifest_heads AS head USING (source_path, generation_id)
        INNER JOIN manifest_watermarks AS watermarks USING (source_path, import_id)
        WHERE history.deleted = 0
      )
    `;
  }

  async function loadClickHouseGenerationSources(client, generationId) {
    if (!generationId) return new Map();
    const rows = await clickHouseJsonEachRow(client, `
      WITH ${clickHouseActiveManifestDefinitions()}
      SELECT
        manifest.source_path AS source_path,
        argMax(source.import_id, tuple(source.segment_end, source.imported_at, source.import_id)) AS import_id,
        argMax(source.fingerprint, tuple(source.segment_end, source.imported_at, source.import_id)) AS fingerprint,
        argMax(source.imported_at, tuple(source.segment_end, source.imported_at, source.import_id)) AS imported_at,
        argMax(source.cursor_version, tuple(source.segment_end, source.imported_at, source.import_id)) AS cursor_version,
        argMax(source.segment_start, tuple(source.segment_end, source.imported_at, source.import_id)) AS segment_start,
        max(source.segment_end) AS segment_end,
        argMax(source.cursor_line, tuple(source.segment_end, source.imported_at, source.import_id)) AS cursor_line,
        argMax(source.cursor_guard, tuple(source.segment_end, source.imported_at, source.import_id)) AS cursor_guard,
        argMax(source.cursor_prefix_guard, tuple(source.segment_end, source.imported_at, source.import_id)) AS cursor_prefix_guard,
        argMax(source.parser_checkpoint, tuple(source.segment_end, source.imported_at, source.import_id)) AS parser_checkpoint,
        argMax(source.file_device, tuple(source.segment_end, source.imported_at, source.import_id)) AS file_device,
        argMax(source.file_inode, tuple(source.segment_end, source.imported_at, source.import_id)) AS file_inode,
        uniqExact(source.import_id) AS active_import_count
      FROM active_manifest AS manifest
      INNER JOIN sources AS source
        ON manifest.source_path = source.source_path
        AND manifest.import_id = source.import_id
        AND (
          isNull(manifest.committed_segment_end)
          OR source.segment_end <= manifest.committed_segment_end
        )
      GROUP BY manifest.source_path
    `, { params: { generation: generationId } });
    return new Map(rows.map((row) => [row.source_path, row]));
  }

  async function loadLegacyClickHouseSources(client) {
    const rows = await clickHouseJsonEachRow(client, `
      SELECT
        source_path,
        '' AS import_id,
        argMax(raw.fingerprint, tuple(raw.imported_at, raw.fingerprint)) AS fingerprint
      FROM sources AS raw
      WHERE raw.import_id = ''
      GROUP BY source_path
    `);
    return new Map(rows.map((row) => [row.source_path, row]));
  }

  async function commitClickHouseGeneration(
    client,
    sourceStates,
    previousCommitMs,
    previousGenerationId,
    options = {},
    changedPaths = null,
    checkpoint = false,
  ) {
    const generationId = randomUUID();
    const committedAtMs = Math.max(Date.now(), number(previousCommitMs) + 1);
    const manifestRow = (sourcePath) => {
      const state = sourceStates.get(sourcePath);
      return {
        generation_id: generationId,
        source_path: sourcePath,
        import_id: state?.import_id || "",
        committed_segment_end: state?.segment_end === undefined || state?.segment_end === null
          ? null
          : number(state.segment_end),
        deleted: state ? 0 : 1,
      };
    };
    const deltaRows = changedPaths ? [...changedPaths].map(manifestRow) : [];
    if (checkpoint) {
      await clickHouseInsertRows(client, "import_generation_sources", [...sourceStates.keys()].map(manifestRow), options);
      await clickHouseInsertRows(client, "import_generation_source_deltas", (previousGenerationId ? deltaRows : []).map((row) => ({
        committed_at_ms: committedAtMs,
        ...row,
      })), options);
      await clickHouseInsertRows(client, "import_generation_checkpoints", [{
        base_committed_at_ms: number(previousCommitMs),
        base_generation_id: previousGenerationId || "",
        committed_at_ms: committedAtMs,
        generation_id: generationId,
      }], options);
    } else {
      await clickHouseInsertRows(client, "import_generation_source_deltas", deltaRows.map((row) => ({
        committed_at_ms: committedAtMs,
        ...row,
      })), options);
    }
    await clickHouseInsertRows(client, "import_generations", [{
      generation_id: generationId,
      committed_at_ms: committedAtMs,
    }], options);
    return { generation_id: generationId, committed_at_ms: committedAtMs };
  }

  async function clickHouseManifestDeltaGenerations(client, generationId) {
    if (!generationId) return 0;
    const rows = await clickHouseJsonEachRow(client, `
      WITH ${clickHouseActiveManifestDefinitions()}
      SELECT uniqExact(generation_id) AS delta_generations
      FROM manifest_deltas
    `, { params: { generation: generationId } });
    return number(rows[0]?.delta_generations);
  }

  async function ensureClickHouseManifestCheckpoint(client, committed, options = {}) {
    if (!committed?.generation_id) return;
    const rows = await clickHouseJsonEachRow(client, `
      SELECT checkpoint.generation_id AS generation_id
      FROM import_generation_checkpoints AS checkpoint
      INNER JOIN import_generations AS committed USING (generation_id)
      WHERE tuple(committed.committed_at_ms, committed.generation_id)
        <= tuple({committedAt:UInt64}, {generation:String})
      ORDER BY committed.committed_at_ms DESC, committed.generation_id DESC
      LIMIT 1
    `, {
      params: {
        committedAt: committed.committed_at_ms,
        generation: committed.generation_id,
      },
    });
    if (rows.length > 0) return;
    await clickHouseInsertRows(client, "import_generation_checkpoints", [{
      base_committed_at_ms: committed.committed_at_ms,
      base_generation_id: committed.generation_id,
      committed_at_ms: committed.committed_at_ms,
      generation_id: committed.generation_id,
    }], options);
  }

  async function ensureClickHouseBaselineGeneration(client, options = {}) {
    const committed = await latestClickHouseGeneration(client);
    if (committed) {
      await ensureClickHouseManifestCheckpoint(client, committed, options);
      return committed;
    }
    const legacySources = await loadLegacyClickHouseSources(client);
    if (legacySources.size === 0) return null;
    return commitClickHouseGeneration(client, legacySources, 0, "", options, null, true);
  }

  async function loadClickHouseCodexSessionHeaders(client, generationId) {
    if (!generationId) return [];
    return clickHouseJsonEachRow(client, `
      WITH ${clickHouseActiveManifestDefinitions()}
      SELECT
        headers.session_id AS session_id,
        argMax(headers.parent_session_id, headers.updated_at_ms) AS parent_session_id,
        argMax(headers.source_path, headers.updated_at_ms) AS source_path,
        argMax(headers.kind, headers.updated_at_ms) AS kind,
        argMax(headers.archive_path, headers.updated_at_ms) AS archive_path,
        argMax(headers.entry_name, headers.updated_at_ms) AS entry_name
      FROM (
        SELECT
          session_id, parent_session_id, source_path, import_id,
          kind, archive_path, entry_name, segment_end, updated_at_ms
        FROM codex_session_versions
        UNION ALL
        SELECT
          session_id, parent_session_id, source_path, import_id,
          kind, archive_path, entry_name, segment_end, updated_at_ms
        FROM codex_sessions
      ) AS headers
      INNER JOIN active_manifest AS manifest
        ON manifest.source_path = headers.source_path
        AND manifest.import_id = headers.import_id
        AND (
          isNull(manifest.committed_segment_end)
          OR headers.segment_end <= manifest.committed_segment_end
        )
      GROUP BY headers.session_id
    `, { params: { generation: generationId } });
  }

  async function storeClickHouseCodexSessionHeaders(client, headers, sourceStates, changedSources, options = {}) {
    const rowsBySession = new Map();
    for (const header of headers || []) {
      const sessionId = normalizeCodexUuid(header?.id);
      const source = header?.source;
      const sourceState = sourceStates.get(source?.sourcePath);
      if (!sessionId || !source?.sourcePath || !source.kind || !sourceState || !changedSources.has(source.sourcePath)) continue;
      rowsBySession.set(sessionId, {
        sessionId,
        parentSessionId: normalizeCodexUuid(header.forkedFromId),
        sourcePath: source.sourcePath,
        importId: sourceState.import_id || "",
        kind: source.kind,
        archivePath: source.archivePath || null,
        entryName: source.entryName || null,
        segmentEnd: number(sourceState.segment_end),
        updatedAt: new Date().toISOString(),
      });
    }
    const rows = [...rowsBySession.values()].map((row) => ({
      session_id: row.sessionId,
      parent_session_id: row.parentSessionId || "",
      source_path: row.sourcePath,
      import_id: row.importId,
      kind: row.kind,
      archive_path: row.archivePath || "",
      entry_name: row.entryName || "",
      segment_end: row.segmentEnd,
      updated_at_ms: Date.parse(row.updatedAt),
    }));
    await clickHouseInsertRows(client, "codex_session_versions", rows, options);
  }

  function removeSupersededClickHouseSources(sourceStates, changedSources, manifestChanges, currentHeaders, persistedHeaders) {
    const persistedSourceBySession = new Map();
    for (const header of persistedHeaders || []) {
      const sessionId = normalizeCodexUuid(header.sessionId ?? header.session_id);
      const sourcePath = header.sourcePath ?? header.source_path;
      if (sessionId && sourcePath) persistedSourceBySession.set(sessionId, sourcePath);
    }

    let removed = 0;
    for (const header of currentHeaders || []) {
      const sessionId = normalizeCodexUuid(header?.id);
      const sourcePath = header?.source?.sourcePath;
      if (!sessionId || !sourcePath || !changedSources.has(sourcePath)) continue;
      const previousPath = persistedSourceBySession.get(sessionId);
      if (previousPath && previousPath !== sourcePath && sourceStates.delete(previousPath)) {
        manifestChanges.add(previousPath);
        removed += 1;
      }
    }
    return removed;
  }

  function clickHouseSessionRow(session, importId, source = {}) {
    return {
      source_path: session.path,
      import_id: importId,
      kind: session.kind,
      archive_path: session.archivePath || "",
      entry_name: session.entryName || "",
      size_bytes: number(session.sizeBytes),
      compressed_size_bytes: number(session.compressedSizeBytes),
      started_at: session.startedAt || "",
      finished_at: session.finishedAt || "",
      duration_ms: number(session.durationMs),
      lines: number(session.lines),
      records: number(session.records),
      parse_errors: number(session.parseErrors),
      token_count_snapshots: number(session.tokenCountSnapshots),
      skipped_token_count_snapshots: number(session.skippedTokenCountSnapshots),
      segment_start: number(source.segmentStart),
      segment_end: number(source.segmentEnd),
      stats_json: JSON.stringify(session.stats),
    };
  }

  function clickHouseUsageEventRow(event, defaultSourcePath, importId, segmentEnd) {
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
    return {
      source_path: event.sourcePath || defaultSourcePath,
      import_id: importId,
      segment_end: number(segmentEnd),
      line_no: number(event.lineNo),
      event_key: event.requestId ? `request:${event.requestId}` : `line:${number(event.lineNo)}`,
      timestamp: event.timestamp || null,
      date_key: dateKey(timestamp),
      week_key: weekKey(timestamp),
      month_key: monthKey(timestamp),
      year_key: yearKey(timestamp),
      provider: event.provider,
      model: event.model,
      project: event.project,
      effort: event.effort,
      service_tier: normalizeServiceTier(event.serviceTier),
      service_mode: normalizeServiceMode(event.serviceMode),
      agent: normalizeAgent(event.agent, event.provider),
      input: number(event.usage.input),
      cache_create_5m: number(event.usage.cacheCreate5m),
      cache_create_30m: number(event.usage.cacheCreate30m),
      cache_create_1h: number(event.usage.cacheCreate1h),
      cache_read: number(event.usage.cacheRead),
      output: number(event.usage.output),
      reasoning_output: number(event.usage.reasoningOutput),
      context_window: number(event.usage.contextWindow),
      priced: event.cost.known ? 1 : 0,
      cost_usd: number(event.cost.amount),
      reasoning_cost_usd: number(event.cost.reasoningAmount),
      cost_input_usd: number(event.cost.breakdown.input),
      cost_cache_create_5m_usd: number(event.cost.breakdown.cacheCreate5m),
      cost_cache_create_30m_usd: number(event.cost.breakdown.cacheCreate30m),
      cost_cache_create_1h_usd: number(event.cost.breakdown.cacheCreate1h),
      cost_cache_read_usd: number(event.cost.breakdown.cacheRead),
      cost_output_usd: number(event.cost.breakdown.output),
      visible_input_chars: number(event.visibleChars?.input),
      visible_output_chars: number(event.visibleChars?.output),
      visible_total_chars: number(event.visibleChars?.total),
      visible_chars_per_token: number(event.visibleChars?.charsPerToken),
    };
  }

  function clickHouseOutputCharMetricRow(event, defaultSourcePath, importId) {
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
    return {
      source_path: event.sourcePath || defaultSourcePath,
      import_id: importId,
      turn_id: event.turnId || "",
      turn_key: event.turnKey || (event.turnId ? `id:${event.turnId}` : `line:${number(event.lineNo)}`),
      metric_revision: number(event.metricRevision),
      timestamp: event.timestamp || null,
      date_key: dateKey(timestamp),
      week_key: weekKey(timestamp),
      month_key: monthKey(timestamp),
      year_key: yearKey(timestamp),
      provider: event.provider,
      model: event.model,
      project: event.project,
      effort: event.effort,
      visible_output_chars: number(event.visibleOutputChars),
      visible_output_tokens: number(event.visibleOutputTokens),
      output_chars_per_token: number(event.charsPerToken),
    };
  }

  function clickHouseRateLimitSampleRow(sample, defaultSourcePath, importId, segmentEnd) {
    const timestamp = new Date(sample.timestampMs);
    return {
      source_path: sample.sourcePath || defaultSourcePath,
      import_id: importId,
      segment_end: number(segmentEnd),
      line_no: number(sample.lineNo),
      sample_key: sample.key,
      group_key: sample.groupKey,
      sequence: number(sample.sequence),
      timestamp_ms: number(sample.timestampMs),
      date_key: dateKey(timestamp),
      week_key: weekKey(timestamp),
      limit_id: sample.windowMeta.limitId || null,
      limit_name: sample.windowMeta.limitName || null,
      plan_type: sample.windowMeta.planType || null,
      kind: sample.windowMeta.kind,
      window_minutes: number(sample.windowMeta.windowMinutes),
      used_percent: number(sample.usedPercent),
      resets_at: number(sample.resetsAt),
      reached: sample.reached ? 1 : 0,
      agent: sample.agent,
      effort: sample.effort,
      model: sample.model,
      input: number(sample.usage.input),
      cache_read: number(sample.usage.cacheRead),
      output: number(sample.usage.output),
      reasoning_output: number(sample.usage.reasoningOutput),
      priced: sample.cost.known ? 1 : 0,
      cost_usd: number(sample.cost.amount),
      reasoning_cost_usd: number(sample.cost.reasoningAmount),
    };
  }

  function clickHouseTelemetryEventRow(event, defaultSourcePath, importId, segmentEnd) {
    const timestamp = new Date(event.timestamp);
    return {
      source_path: event.sourcePath || defaultSourcePath,
      import_id: importId,
      segment_end: number(segmentEnd),
      line_no: number(event.lineNo),
      timestamp: event.timestamp,
      timestamp_ms: timestamp.getTime(),
      date_key: dateKey(timestamp),
      provider: event.provider,
      agent: event.agent,
      model: event.model,
      project: event.project,
      event_kind: event.eventKind,
      raw_json: event.rawJson,
    };
  }

  function clickHouseInsertSettings(options = {}) {
    return {
      rows: options.clickhouseInsertBatchRows || DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS,
      bytes: options.clickhouseInsertBatchBytes || DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES,
    };
  }

  function createClickHouseRowSink(client, table, options = {}) {
    const limits = clickHouseInsertSettings(options);
    let lines = [];
    let bytes = 0;
    let pending = Promise.resolve();

    const flush = () => {
      if (lines.length === 0) return pending;
      const chunk = lines;
      lines = [];
      bytes = 0;
      pending = pending.then(() => clickHouseInsertLines(client, table, chunk));
      return pending;
    };

    return {
      push(row) {
        const line = JSON.stringify(row);
        lines.push(line);
        bytes += Buffer.byteLength(line) + 1;
      },
      drainIfFull() {
        return lines.length >= limits.rows || bytes >= limits.bytes ? flush() : null;
      },
      finish() {
        return flush();
      },
    };
  }

  function drainClickHouseSinks(sinks) {
    const flushes = sinks
      .map((sink) => sink.drainIfFull())
      .filter(Boolean);
    return flushes.length ? Promise.all(flushes) : null;
  }

  async function processAndStoreClickHouseSource(client, source, fingerprint, options) {
    // A source keeps one immutable epoch id for its append-only lifetime.
    // Rewrites create a new epoch; ordinary tails add rows to the same one.
    const importId = source.importId || randomUUID();
    const usageSink = createClickHouseRowSink(client, "usage_events", options);
    const outputCharMetricSink = createClickHouseRowSink(client, "output_char_metrics", options);
    const rateLimitSink = createClickHouseRowSink(client, "rate_limit_samples", options);
    const telemetrySink = createClickHouseRowSink(client, "telemetry_events", options);
    const report = newReport();
    report._usageEventSink = (event) => usageSink.push(clickHouseUsageEventRow(event, source.path, importId, source.segmentEnd));
    report._outputCharMetricSink = (event) => outputCharMetricSink.push(clickHouseOutputCharMetricRow({
      ...event,
      metricRevision: source.segmentEnd,
    }, source.path, importId));
    report._rateLimitSampleSink = (sample) => rateLimitSink.push(clickHouseRateLimitSampleRow(sample, source.path, importId, source.segmentEnd));
    report._telemetryEventSink = (event) => telemetrySink.push(clickHouseTelemetryEventRow(event, source.path, importId, source.segmentEnd));
    report._afterLine = () => drainClickHouseSinks([usageSink, outputCharMetricSink, rateLimitSink, telemetrySink]);

    let processingResult = null;
    if (source.kind === "jsonl") {
      processingResult = await processJsonlFile(source.path, report, options, source.inputMeta || null);
    } else if (source.kind === "zip-entry") {
      await processZipEntry(source.archivePath, source.entry, report, options);
    } else {
      throw new Error(`Unsupported ClickHouse source kind: ${source.kind}`);
    }

    await usageSink.finish();
    await outputCharMetricSink.finish();
    await rateLimitSink.finish();
    await telemetrySink.finish();
    await clickHouseInsertRows(client, "sessions", report.sessions.map((session) => clickHouseSessionRow(session, importId, source)), options);
    // Insert the marker only after every source-owned table has been written.
    source.cursorLine = processingResult?.lineNo || source.cursorLine || 0;
    source.parserCheckpoint = processingResult?.parserCheckpoint || null;
    const sourceRow = clickHouseSourceRow(source, fingerprint, importId);
    await clickHouseInsertRows(client, "sources", [sourceRow], options);
    return {
      report,
      sourceState: {
        ...sourceRow,
      },
    };
  }

  async function clickHouseInsertLines(client, table, lines) {
    if (lines.length === 0) return;
    const body = `${lines.join("\n")}\n`;
    await clickHouseRequest(client, `INSERT INTO ${table} FORMAT JSONEachRow`, { body });
  }

  async function clickHouseInsertRows(client, table, rows, options = {}) {
    const sink = createClickHouseRowSink(client, table, options);
    for (const row of rows) {
      sink.push(row);
      const flush = sink.drainIfFull();
      if (flush) await flush;
    }
    await sink.finish();
  }

  function clickHouseAppendableJsonlInput(input) {
    return input.path.endsWith(".jsonl") && ![
      "cursor",
      "grok",
      "pi",
      "gemini",
      "qwen",
      "opencode",
    ].includes(input.adapter);
  }

  function hasClickHouseResumableCursor(sourceState) {
    return (
      Number(sourceState?.cursor_version) === APPEND_CURSOR_VERSION
      && Boolean(sourceState?.parser_checkpoint)
      && Boolean(sourceState?.cursor_guard)
      && Boolean(sourceState?.cursor_prefix_guard)
      && sourceState?.file_device !== undefined
      && sourceState?.file_device !== null
      && sourceState?.file_inode !== undefined
      && sourceState?.file_inode !== null
    );
  }

  async function preflightClickHouseAppendSources(preparedInputs, changedSourcePaths, sourceStates) {
    for (const input of preparedInputs) {
      if (
        input.kind !== "jsonl"
        || changedSourcePaths.has(input.path)
        || !clickHouseAppendableJsonlInput(input)
      ) continue;
      const sourceState = sourceStates.get(input.path);
      if (!hasClickHouseResumableCursor(sourceState)) continue;
      const current = await inspectAppendFile(input.path, input.stat);
      const plan = await validateAppendCursor(input.path, sourceState, current);
      input.clickHouseAppendPreflight = { current, plan };
      if (plan.mode !== "unchanged") changedSourcePaths.add(input.path);
    }
  }

  async function syncClickHouseJsonlSource(client, input, sourceStates, options) {
    const stat = input.stat || await fsp.stat(input.path);
    const fingerprint = sourceFingerprint({
      kind: "jsonl",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    const sourceState = sourceStates.get(input.path);
    const appendable = clickHouseAppendableJsonlInput(input);
    if (!appendable) {
      // Other formats have no resumable cursor, so their source fingerprint is
      // the only cheap unchanged-source authority.
      if (sameSourceFingerprint(sourceState?.fingerprint, fingerprint)) return false;
      const staged = await processAndStoreClickHouseSource(client, {
        kind: "jsonl",
        path: input.path,
        sizeBytes: stat.size,
        inputMeta: input,
      }, fingerprint, options);
      sourceStates.set(input.path, staged.sourceState);
      return staged.sourceState;
    }

    // Legacy and deliberately non-resumable parser states still use the source
    // fingerprint. They have no cursor contract that a bounded guard can prove.
    if (
      sameSourceFingerprint(sourceState?.fingerprint, fingerprint)
      && !hasClickHouseResumableCursor(sourceState)
    ) return false;

    // Append-only sources always validate the bounded cursor guards, even if a
    // producer preserves size and mtime while rewriting bytes in place.
    const preflight = input.clickHouseAppendPreflight || null;
    const current = preflight?.current || await inspectAppendFile(input.path, stat);
    if (!sourceState && current.completeOffset === 0) return false;
    let plan = { mode: "full", reason: "new-source", start: 0, end: current.completeOffset };
    if (sourceState && number(sourceState.active_import_count) > 1) {
      plan = { mode: "full", reason: "legacy-multi-import-manifest" };
    } else if (sourceState) {
      plan = preflight?.plan || await validateAppendCursor(input.path, sourceState, current);
    }
    if (plan.mode === "unchanged") return false;
    if (plan.mode === "full") {
      plan.start = 0;
      plan.end = current.completeOffset;
    }
    if (plan.end <= plan.start) return false;

    let parserCheckpoint = null;
    if (plan.mode === "append") {
      try {
        parserCheckpoint = JSON.parse(sourceState.parser_checkpoint);
      } catch {
        plan = { mode: "full", reason: "invalid-checkpoint", start: 0, end: current.completeOffset };
      }
    }

    const stageRange = async (rangePlan, checkpoint = null) => {
      const source = {
        kind: "jsonl",
        path: input.path,
        importId: rangePlan.mode === "append" ? sourceState.import_id : null,
        sizeBytes: stat.size,
        cursorVersion: APPEND_CURSOR_VERSION,
        segmentStart: rangePlan.start,
        segmentEnd: rangePlan.end,
        cursorGuard: current.guard,
        cursorPrefixGuard: current.prefixGuard,
        fileDevice: current.device,
        fileInode: current.inode,
        inputMeta: {
          ...input,
          range: {
            start: rangePlan.start,
            end: rangePlan.end,
            lineNoOffset: rangePlan.mode === "append" ? number(sourceState.cursor_line) : 0,
            parserCheckpoint: checkpoint,
          },
        },
      };
      return processAndStoreClickHouseSource(client, source, fingerprint, options);
    };

    const assertSourceStable = async () => {
      const postStat = await fsp.stat(input.path);
      const sourceStable = (
        String(postStat.dev) === current.device &&
        String(postStat.ino) === current.inode &&
        await appendGuard(input.path, plan.end) === current.guard &&
        await appendPrefixGuard(input.path, plan.end) === current.prefixGuard
      );
      if (!sourceStable) throw new Error(`JSONL source changed while importing: ${input.path}`);
    };
    let staged = await stageRange(plan, parserCheckpoint);
    await assertSourceStable();
    if (plan.mode === "append" && !staged.sourceState.parser_checkpoint) {
      plan = { mode: "full", reason: "checkpoint-became-unsafe", start: 0, end: current.completeOffset };
      staged = await stageRange(plan);
      await assertSourceStable();
    }

    const nextState = staged.sourceState;
    sourceStates.set(input.path, nextState);
    return nextState;
  }

  async function syncClickHouseZipSource(client, input, sourceStates, changedSources, manifestChanges, options, limiter) {
    const stat = input.stat || await fsp.stat(input.path);
    const entries = input.entries || (await listZipEntries(input.path))
      .filter((entry) => entry.fileName.endsWith(".jsonl"))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
    logProgress(options, `[zip] ${input.path} size=${formatBytes(stat.size)} entries=${formatInt(entries.length)}`);

    const archivePrefix = `${input.path}:`;
    const presentSources = new Set(entries.map((entry) => `${archivePrefix}${entry.fileName}`));
    let removed = 0;
    for (const sourcePath of sourceStates.keys()) {
      if (sourcePath.startsWith(archivePrefix) && !presentSources.has(sourcePath)) {
        sourceStates.delete(sourcePath);
        manifestChanges.add(sourcePath);
        removed += 1;
      }
    }

    let changed = 0;
    for (const entry of entries) {
      if (!limiter.take()) continue;
      const sourcePath = `${input.path}:${entry.fileName}`;
      const fingerprint = sourceFingerprint({
        kind: "zip-entry",
        archiveSize: stat.size,
        archiveMtimeMs: stat.mtimeMs,
        entry: entry.fileName,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        localHeaderOffset: entry.localHeaderOffset,
      });
      const sourceState = sourceStates.get(sourcePath);
      // Keep valid unchanged archive entries out of source cleanup as well.
      if (sameSourceFingerprint(sourceState?.fingerprint, fingerprint)) continue;

      const source = {
        kind: "zip-entry",
        path: sourcePath,
        archivePath: input.path,
        entryName: entry.fileName,
        sizeBytes: entry.uncompressedSize,
        compressedSizeBytes: entry.compressedSize,
        entry,
      };
      const staged = await processAndStoreClickHouseSource(client, source, fingerprint, options);
      sourceStates.set(sourcePath, staged.sourceState);
      changedSources.add(sourcePath);
      manifestChanges.add(sourcePath);
      changed += 1;
    }
    return { changed, manifestChanged: changed > 0 || removed > 0 };
  }

  function aggregateStatsFromRow(row) {
    return {
      requests: number(row.requests),
      input: number(row.input),
      cacheCreate5m: number(row.cacheCreate5m),
      cacheCreate30m: number(row.cacheCreate30m),
      cacheCreate1h: number(row.cacheCreate1h),
      cacheRead: number(row.cacheRead),
      output: number(row.output),
      reasoningOutput: number(row.reasoningOutput),
      costUsd: number(row.costUsd),
      reasoningCostUsd: number(row.reasoningCostUsd),
      costsUsd: {
        input: number(row.costInputUsd),
        cacheCreate5m: number(row.costCacheCreate5mUsd),
        cacheCreate30m: number(row.costCacheCreate30mUsd),
        cacheCreate1h: number(row.costCacheCreate1hUsd),
        cacheRead: number(row.costCacheReadUsd),
        output: number(row.costOutputUsd),
      },
      pricedRequests: number(row.pricedRequests),
      unpricedRequests: number(row.unpricedRequests),
      pricedInput: number(row.pricedInput),
      pricedCacheCreate5m: number(row.pricedCacheCreate5m),
      pricedCacheCreate30m: number(row.pricedCacheCreate30m),
      pricedCacheCreate1h: number(row.pricedCacheCreate1h),
      pricedCacheRead: number(row.pricedCacheRead),
      pricedOutput: number(row.pricedOutput),
      pricedReasoningOutput: number(row.pricedReasoningOutput),
      visibleInputChars: number(row.visibleInputChars),
      visibleOutputChars: number(row.visibleOutputChars),
      visibleTotalChars: number(row.visibleTotalChars),
      visibleCharTokenSamples: number(row.visibleCharTokenSamples),
      visibleCharsPerTokenSum: number(row.visibleCharsPerTokenSum),
      visibleCharsPerTokenMin: number(row.visibleCharTokenSamples) > 0 ? number(row.visibleCharsPerTokenMin) : null,
      visibleCharsPerTokenMax: number(row.visibleCharTokenSamples) > 0 ? number(row.visibleCharsPerTokenMax) : null,
      visibleOutputTextChars: 0,
      visibleOutputTextTokens: 0,
      outputCharTokenSamples: 0,
      outputCharsPerTokenSum: 0,
      outputCharsPerTokenMin: null,
      outputCharsPerTokenMax: null,
      outputCharsPerTokenP10: null,
      outputCharsPerTokenP99: null,
      outputCharTokenOutliers: 0,
    };
  }

  function clickHouseLogicalKey(table, alias = "raw") {
    if (table === "usage_events") {
      return [`if(${alias}.event_key = '', concat('line:', toString(${alias}.line_no)), ${alias}.event_key)`];
    }
    if (table === "output_char_metrics") {
      return [`if(${alias}.turn_key = '', concat('legacy:', ${alias}.turn_id, ':', ifNull(${alias}.timestamp, ''), ':', toString(${alias}.visible_output_chars), ':', toString(${alias}.visible_output_tokens)), ${alias}.turn_key)`];
    }
    if (table === "rate_limit_samples") return [`${alias}.line_no`, `${alias}.sample_key`, `${alias}.sequence`];
    if (table === "telemetry_events") return [`${alias}.line_no`, `${alias}.event_kind`];
    return [`${alias}.line_no`];
  }

  function clickHouseCommittedRowsDefinition(table, name) {
    const activeName = `${name}_active`;
    const logicalKey = clickHouseLogicalKey(table, activeName);
    const commitRevision = table === "output_char_metrics" ? "metric_revision" : "segment_end";
    const order = table === "output_char_metrics"
      ? `${activeName}.metric_revision DESC`
      : `${activeName}.line_no ASC`;
    return `
      ${activeName} AS (
        SELECT raw.*
        FROM ${table} AS raw
        INNER JOIN active_manifest AS manifest
          ON manifest.source_path = raw.source_path
          AND manifest.import_id = raw.import_id
          AND (
            isNull(manifest.committed_segment_end)
            OR raw.${commitRevision} <= manifest.committed_segment_end
          )
      ),
      ${name} AS (
        SELECT *
        FROM ${activeName}
        ORDER BY ${order}
        LIMIT 1 BY ${activeName}.source_path, ${activeName}.import_id, ${logicalKey.join(", ")}
      )
    `;
  }

  function clickHouseRepricedDefinitions(table, name, configuration, pricingExpressions = {}, storedCostColumns = CLICKHOUSE_COST_COLUMNS) {
    const pricing = buildClickHouseCostProjection(configuration, { alias: "raw", ...pricingExpressions });
    const longSource = `${name}_long_context`;
    const contextSource = `${name}_context`;
    const pricedSource = `${name}_pricing`;
    return `
      ${clickHouseActiveManifestDefinitions()},
      ${clickHouseCommittedRowsDefinition(table, `${name}_committed`)},
      ${longSource} AS (
        SELECT raw.*, ${pricing.hasLongExpression} AS has_long_price
        FROM ${name}_committed AS raw
      ),
      ${contextSource} AS (
        SELECT raw.*, ${pricing.useLongExpression} AS use_long_price
        FROM ${longSource} AS raw
      ),
      ${pricedSource} AS (
        SELECT raw.*, ${pricing.matchExpression} AS matched_prices
        FROM ${contextSource} AS raw
      ),
      ${name} AS (
        SELECT
          raw.* EXCEPT (${[...storedCostColumns, "has_long_price", "use_long_price", "matched_prices"].join(", ")}),
          ${pricing.projection}
        FROM ${pricedSource} AS raw
      )
    `;
  }

  async function insertClickHousePricingOverlays(client, configuration, generationId) {
    const usageDefinitions = clickHouseRepricedDefinitions("usage_events", "repriced_usage_events", configuration, {
      timestamp: "raw.timestamp",
    });
    await clickHouseRequest(client, `
      INSERT INTO usage_event_costs (
        pricing_revision, source_path, import_id, line_no, priced, cost_usd,
        reasoning_cost_usd, cost_input_usd, cost_cache_create_5m_usd,
        cost_cache_create_30m_usd, cost_cache_create_1h_usd,
        cost_cache_read_usd, cost_output_usd
      )
      WITH ${usageDefinitions}
      SELECT
        {pricingRevision:String}, source_path, import_id, line_no, priced, cost_usd,
        reasoning_cost_usd, cost_input_usd, cost_cache_create_5m_usd,
        cost_cache_create_30m_usd, cost_cache_create_1h_usd,
        cost_cache_read_usd, cost_output_usd
      FROM repriced_usage_events
    `, { params: { generation: generationId, pricingRevision: configuration.settings.pricingRevision } });

    const model = "lowerUTF8(trimBoth(toString(raw.model)))";
    const provider = `multiIf(startsWith(${model}, 'claude-'), 'anthropic', startsWith(${model}, 'gpt-') OR startsWith(${model}, 'o') OR ${model} = 'chat-latest', 'openai', 'unknown')`;
    const rateDefinitions = clickHouseRepricedDefinitions("rate_limit_samples", "repriced_rate_limit_samples", configuration, {
      provider,
      serviceTier: "'unknown'",
      serviceMode: "'unknown'",
      timestamp: "fromUnixTimestamp64Milli(toInt64(raw.timestamp_ms))",
      timestampIsDateTime: true,
      cacheCreate5m: "0",
      cacheCreate30m: "0",
      cacheCreate1h: "0",
    }, ["priced", "cost_usd", "reasoning_cost_usd"]);
    await clickHouseRequest(client, `
      INSERT INTO rate_limit_sample_costs (
        pricing_revision, source_path, import_id, line_no, sample_key, sequence,
        priced, cost_usd, reasoning_cost_usd
      )
      WITH ${rateDefinitions}
      SELECT
        {pricingRevision:String}, source_path, import_id, line_no, sample_key, sequence,
        priced, cost_usd, reasoning_cost_usd
      FROM repriced_rate_limit_samples
    `, { params: { generation: generationId, pricingRevision: configuration.settings.pricingRevision } });
  }

  function clickHouseGenerationCte(table, name, configuration) {
    if (!configuration) {
      return `
        WITH ${clickHouseActiveManifestDefinitions()},
        ${clickHouseCommittedRowsDefinition(table, name)}
      `;
    }
    const replacements = CLICKHOUSE_COST_COLUMNS.map((column) => (
      `if(costs.pricing_revision = '', raw.${column}, costs.${column}) AS ${column}`
    )).join(",\n          ");
    return `
      WITH ${clickHouseActiveManifestDefinitions()},
      ${clickHouseCommittedRowsDefinition(table, `${name}_raw`)},
      ${name} AS (
        SELECT
          raw.* REPLACE (${replacements})
        FROM ${name}_raw AS raw
        LEFT JOIN usage_event_costs AS costs
          ON costs.pricing_revision = {pricingRevision:String}
          AND costs.source_path = raw.source_path
          AND costs.import_id = raw.import_id
          AND costs.line_no = raw.line_no
      )
    `;
  }

  const CLICKHOUSE_USAGE_GROUPING_DIMENSIONS = [
    "quarter_hour",
    "date_key",
    "week_key",
    "month_key",
    "year_key",
    "provider",
    "model",
    "project",
    "effort",
    "service_tier",
    "service_mode",
    "agent",
    "source_path",
  ];

  const CLICKHOUSE_USAGE_GROUPS = [
    { bucket: "total", grouped: [] },
    { bucket: "quarterHourly", grouped: ["quarter_hour"], keys: ["quarter_hour"] },
    { bucket: "quarterHourlyProviderModels", grouped: ["quarter_hour", "provider", "model"], keys: ["quarter_hour", "provider", "model"] },
    { bucket: "daily", grouped: ["date_key"], keys: ["date_key"] },
    { bucket: "weekly", grouped: ["week_key"], keys: ["week_key"] },
    { bucket: "monthly", grouped: ["month_key"], keys: ["month_key"] },
    { bucket: "yearly", grouped: ["year_key"], keys: ["year_key"] },
    { bucket: "providers", grouped: ["provider"], keys: ["provider"] },
    { bucket: "models", grouped: ["model"], keys: ["model"] },
    { bucket: "providerModels", grouped: ["provider", "model"], keys: ["concat(provider, '/', model)"] },
    { bucket: "projects", grouped: ["project"], keys: ["project"] },
    { bucket: "projectDaily", grouped: ["project", "date_key"], keys: ["project", "date_key"] },
    { bucket: "projectQuarterHourly", grouped: ["project", "quarter_hour"], keys: ["project", "quarter_hour"] },
    { bucket: "projectQuarterHourlyProviderModels", grouped: ["project", "quarter_hour", "provider", "model"], keys: ["project", "quarter_hour", "provider", "model"] },
    { bucket: "projectModels", grouped: ["project", "model"], keys: ["project", "model"] },
    { bucket: "projectProviderModels", grouped: ["project", "provider", "model"], keys: ["project", "provider", "model"] },
    { bucket: "efforts", grouped: ["effort"], keys: ["effort"] },
    { bucket: "serviceTiers", grouped: ["service_tier"], keys: ["service_tier"] },
    { bucket: "serviceModes", grouped: ["service_mode"], keys: ["service_mode"] },
    { bucket: "agents", grouped: ["agent"], keys: ["agent"] },
    { bucket: "modelEfforts", grouped: ["model", "effort"], keys: ["model", "effort"] },
    { bucket: "providerModelEffortDaily", grouped: ["provider", "model", "effort", "date_key"], keys: ["provider", "model", "effort", "date_key"] },
    { bucket: "sourceStats", grouped: ["source_path"], keys: ["source_path"] },
  ];

  function clickHouseUsageGroupingMask(grouped) {
    return CLICKHOUSE_USAGE_GROUPING_DIMENSIONS.reduce((mask, dimension, index) => (
      grouped.includes(dimension)
        ? mask
        : mask | (1 << (CLICKHOUSE_USAGE_GROUPING_DIMENSIONS.length - index - 1))
    ), 0);
  }

  function clickHouseUsageGroupExpression(selector) {
    const branches = [];
    for (const group of CLICKHOUSE_USAGE_GROUPS) {
      const value = selector(group);
      if (value === null || value === undefined) continue;
      branches.push(`groupingMask = ${clickHouseUsageGroupingMask(group.grouped)}, ${value}`);
    }
    return `multiIf(\n          ${branches.join(",\n          ")},\n          '')`;
  }

  function clickHouseUsageStatsQuery(generationCte) {
    const groupingExpression = `grouping(${CLICKHOUSE_USAGE_GROUPING_DIMENSIONS.join(", ")})`;
    const bucketExpression = clickHouseUsageGroupExpression((group) => `'${group.bucket}'`);
    const keyExpressions = [0, 1, 2, 3].map((keyIndex) => (
      clickHouseUsageGroupExpression((group) => group.keys?.[keyIndex])
    ));
    const groupingSets = CLICKHOUSE_USAGE_GROUPS.map((group) => (
      group.grouped.length > 0 ? `(${group.grouped.join(", ")})` : "()"
    )).join(",\n        ");
    const timestampGroupingMasks = CLICKHOUSE_USAGE_GROUPS
      .filter((group) => group.grouped.includes("quarter_hour"))
      .map((group) => clickHouseUsageGroupingMask(group.grouped))
      .join(", ");

    return `${generationCte}, usage_events_with_dimensions AS (
        SELECT
          committed_usage_events.*,
          ifNull(
            formatDateTime(
              toStartOfInterval(parseDateTimeBestEffortOrNull(timestamp), INTERVAL 15 MINUTE),
              '%Y-%m-%dT%H:%iZ',
              'UTC'
            ),
            ''
          ) AS quarter_hour
        FROM committed_usage_events
      )
      SELECT
        ${groupingExpression} AS groupingMask,
        ${bucketExpression} AS bucket,
        ${keyExpressions[0]} AS key1,
        ${keyExpressions[1]} AS key2,
        ${keyExpressions[2]} AS key3,
        ${keyExpressions[3]} AS key4,
        count() AS requests,
        sum(input) AS input,
        sum(cache_create_5m) AS cacheCreate5m,
        sum(cache_create_30m) AS cacheCreate30m,
        sum(cache_create_1h) AS cacheCreate1h,
        sum(cache_read) AS cacheRead,
        sum(output) AS output,
        sum(reasoning_output) AS reasoningOutput,
        sum(cost_usd) AS costUsd,
        sum(reasoning_cost_usd) AS reasoningCostUsd,
        sum(cost_input_usd) AS costInputUsd,
        sum(cost_cache_create_5m_usd) AS costCacheCreate5mUsd,
        sum(cost_cache_create_30m_usd) AS costCacheCreate30mUsd,
        sum(cost_cache_create_1h_usd) AS costCacheCreate1hUsd,
        sum(cost_cache_read_usd) AS costCacheReadUsd,
        sum(cost_output_usd) AS costOutputUsd,
        sum(priced) AS pricedRequests,
        count() - sum(priced) AS unpricedRequests,
        sumIf(usage_events.input, usage_events.priced = 1) AS pricedInput,
        sumIf(usage_events.cache_create_5m, usage_events.priced = 1) AS pricedCacheCreate5m,
        sumIf(usage_events.cache_create_30m, usage_events.priced = 1) AS pricedCacheCreate30m,
        sumIf(usage_events.cache_create_1h, usage_events.priced = 1) AS pricedCacheCreate1h,
        sumIf(usage_events.cache_read, usage_events.priced = 1) AS pricedCacheRead,
        sumIf(usage_events.output, usage_events.priced = 1) AS pricedOutput,
        sumIf(usage_events.reasoning_output, usage_events.priced = 1) AS pricedReasoningOutput,
        sum(visible_input_chars) AS visibleInputChars,
        sum(visible_output_chars) AS visibleOutputChars,
        sum(visible_total_chars) AS visibleTotalChars,
        countIf(visible_chars_per_token > 0) AS visibleCharTokenSamples,
        sumIf(visible_chars_per_token, visible_chars_per_token > 0) AS visibleCharsPerTokenSum,
        minIf(visible_chars_per_token, visible_chars_per_token > 0) AS visibleCharsPerTokenMin,
        maxIf(visible_chars_per_token, visible_chars_per_token > 0) AS visibleCharsPerTokenMax
      FROM usage_events_with_dimensions AS usage_events
      GROUP BY GROUPING SETS (
        ${groupingSets}
      )
      HAVING groupingMask NOT IN (${timestampGroupingMasks}) OR quarter_hour != ''
    `;
  }

  async function applyClickHouseUsageStats(client, report, generationId, configuration) {
    const rows = await clickHouseJsonEachRow(client, clickHouseUsageStatsQuery(
      clickHouseGenerationCte("usage_events", "committed_usage_events", configuration),
    ), { params: { generation: generationId, pricingRevision: configuration.settings.pricingRevision } });

    const sourceStats = new Map();
    for (const row of rows) {
      const stats = aggregateStatsFromRow(row);
      if (row.bucket === "sourceStats") sourceStats.set(row.key1, stats);
      else if (row.bucket === "total") report.total = stats;
      else if (row.bucket === "quarterHourly") report.quarterHourly[row.key1] = stats;
      else if (row.bucket === "quarterHourlyProviderModels") {
        report.quarterHourlyProviderModels[row.key1] ??= {};
        report.quarterHourlyProviderModels[row.key1][row.key2] ??= {};
        report.quarterHourlyProviderModels[row.key1][row.key2][row.key3] = stats;
      }
      else if (row.bucket === "daily") report.daily[row.key1] = stats;
      else if (row.bucket === "weekly") report.weekly[row.key1] = stats;
      else if (row.bucket === "monthly") report.monthly[row.key1] = stats;
      else if (row.bucket === "yearly") report.yearly[row.key1] = stats;
      else if (row.bucket === "providers") report.providers[row.key1] = stats;
      else if (row.bucket === "models") report.models[row.key1] = stats;
      else if (row.bucket === "providerModels") report.providerModels[row.key1] = stats;
      else if (row.bucket === "serviceTiers") report.serviceTiers[row.key1] = stats;
      else if (row.bucket === "serviceModes") report.serviceModes[row.key1] = stats;
      else if (row.bucket === "agents") report.agents[row.key1] = stats;
      else if (row.bucket === "projects") report.projects[row.key1] = stats;
      else if (row.bucket === "projectDaily") {
        report.projectDaily[row.key1] ??= {};
        report.projectDaily[row.key1][row.key2] = stats;
      }
      else if (row.bucket === "projectQuarterHourly") {
        report.projectQuarterHourly[row.key1] ??= {};
        report.projectQuarterHourly[row.key1][row.key2] = stats;
      }
      else if (row.bucket === "projectQuarterHourlyProviderModels") {
        report.projectQuarterHourlyProviderModels[row.key1] ??= {};
        report.projectQuarterHourlyProviderModels[row.key1][row.key2] ??= {};
        report.projectQuarterHourlyProviderModels[row.key1][row.key2][row.key3] ??= {};
        report.projectQuarterHourlyProviderModels[row.key1][row.key2][row.key3][row.key4] = stats;
      }
      else if (row.bucket === "projectModels") {
        report.projectModels[row.key1] ??= {};
        report.projectModels[row.key1][row.key2] = stats;
      } else if (row.bucket === "projectProviderModels") {
        report.projectProviderModels[row.key1] ??= {};
        report.projectProviderModels[row.key1][row.key2] ??= {};
        report.projectProviderModels[row.key1][row.key2][row.key3] = stats;
      } else if (row.bucket === "efforts") report.efforts[row.key1] = stats;
      else if (row.bucket === "modelEfforts") {
        report.modelEfforts[row.key1] ??= {};
        report.modelEfforts[row.key1][row.key2] = stats;
      } else if (row.bucket === "providerModelEffortDaily") {
        const target = providerModelEffortDailyBucket(report, row.key1, row.key2, row.key3, row.key4);
        Object.assign(target, stats);
      }
    }
    return sourceStats;
  }

  function mergeOutputCharMetricStats(target, row) {
    target.visibleOutputTextChars += number(row.visibleOutputTextChars);
    target.visibleOutputTextTokens += number(row.visibleOutputTextTokens);
    target.outputCharTokenOutliers += number(row.outputCharTokenOutliers);
    const samples = number(row.outputCharTokenSamples);
    if (samples <= 0) return;
    target.outputCharTokenSamples += samples;
    target.outputCharsPerTokenSum += number(row.outputCharsPerTokenSum);
    const min = number(row.outputCharsPerTokenMin);
    const max = number(row.outputCharsPerTokenMax);
    target.outputCharsPerTokenMin = target.outputCharsPerTokenMin === null
      ? min
      : Math.min(target.outputCharsPerTokenMin, min);
    target.outputCharsPerTokenMax = target.outputCharsPerTokenMax === null
      ? max
      : Math.max(target.outputCharsPerTokenMax, max);
  }

  const CLICKHOUSE_OUTPUT_CHAR_GROUPING_DIMENSIONS = [
    "date_key",
    "week_key",
    "month_key",
    "year_key",
    "provider",
    "model",
    "project",
    "effort",
    "source_path",
  ];

  const CLICKHOUSE_OUTPUT_CHAR_GROUPS = [
    { bucket: "total", grouped: [] },
    { bucket: "daily", grouped: ["date_key"], keys: ["date_key"] },
    { bucket: "weekly", grouped: ["week_key"], keys: ["week_key"] },
    { bucket: "monthly", grouped: ["month_key"], keys: ["month_key"] },
    { bucket: "yearly", grouped: ["year_key"], keys: ["year_key"] },
    { bucket: "providers", grouped: ["provider"], keys: ["provider"] },
    { bucket: "models", grouped: ["model"], keys: ["model"] },
    { bucket: "providerModels", grouped: ["provider", "model"], keys: ["concat(provider, '/', model)"] },
    { bucket: "projects", grouped: ["project"], keys: ["project"] },
    { bucket: "projectDaily", grouped: ["project", "date_key"], keys: ["project", "date_key"] },
    { bucket: "projectModels", grouped: ["project", "model"], keys: ["project", "model"] },
    { bucket: "efforts", grouped: ["effort"], keys: ["effort"] },
    { bucket: "modelEfforts", grouped: ["model", "effort"], keys: ["model", "effort"] },
    { bucket: "sourceStats", grouped: ["source_path"], keys: ["source_path"] },
  ];

  function clickHouseOutputCharGroupingMask(grouped) {
    return CLICKHOUSE_OUTPUT_CHAR_GROUPING_DIMENSIONS.reduce((mask, dimension, index) => (
      grouped.includes(dimension)
        ? mask
        : mask | (1 << (CLICKHOUSE_OUTPUT_CHAR_GROUPING_DIMENSIONS.length - index - 1))
    ), 0);
  }

  function clickHouseOutputCharGroupExpression(selector) {
    const branches = [];
    for (const group of CLICKHOUSE_OUTPUT_CHAR_GROUPS) {
      const value = selector(group);
      if (value === null || value === undefined) continue;
      branches.push(`groupingMask = ${clickHouseOutputCharGroupingMask(group.grouped)}, ${value}`);
    }
    return `multiIf(\n          ${branches.join(",\n          ")},\n          '')`;
  }

  function clickHouseOutputCharStatsQuery(generationCte) {
    const groupingExpression = `grouping(${CLICKHOUSE_OUTPUT_CHAR_GROUPING_DIMENSIONS.join(", ")})`;
    const bucketExpression = clickHouseOutputCharGroupExpression((group) => `'${group.bucket}'`);
    const keyExpressions = [0, 1].map((keyIndex) => (
      clickHouseOutputCharGroupExpression((group) => group.keys?.[keyIndex])
    ));
    const groupingSets = CLICKHOUSE_OUTPUT_CHAR_GROUPS.map((group) => (
      group.grouped.length > 0 ? `(${group.grouped.join(", ")})` : "()"
    )).join(",\n        ");

    return `${generationCte}
      SELECT
        ${groupingExpression} AS groupingMask,
        ${bucketExpression} AS bucket,
        ${keyExpressions[0]} AS key1,
        ${keyExpressions[1]} AS key2,
        sumIf(visible_output_chars, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS visibleOutputTextChars,
        sumIf(visible_output_tokens, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS visibleOutputTextTokens,
        countIf(output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharTokenSamples,
        sumIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenSum,
        minIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenMin,
        maxIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenMax,
        countIf(output_chars_per_token > ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharTokenOutliers
      FROM committed_output_char_metrics AS output_char_metrics
      GROUP BY GROUPING SETS (
        ${groupingSets}
      )
    `;
  }

  function outputCharTargetForBucket(report, row) {
    if (row.bucket === "total") return report.total;
    if (row.bucket === "daily") return bucket(report.daily, row.key1);
    if (row.bucket === "weekly") return bucket(report.weekly, row.key1);
    if (row.bucket === "monthly") return bucket(report.monthly, row.key1);
    if (row.bucket === "yearly") return bucket(report.yearly, row.key1);
    if (row.bucket === "providers") return bucket(report.providers, row.key1);
    if (row.bucket === "models") return bucket(report.models, row.key1);
    if (row.bucket === "providerModels") return bucket(report.providerModels, row.key1);
    if (row.bucket === "projects") return bucket(report.projects, row.key1);
    if (row.bucket === "projectDaily") return nestedBucket(report.projectDaily, row.key1, row.key2);
    if (row.bucket === "projectModels") return nestedBucket(report.projectModels, row.key1, row.key2);
    if (row.bucket === "efforts") return bucket(report.efforts, row.key1);
    if (row.bucket === "modelEfforts") return nestedBucket(report.modelEfforts, row.key1, row.key2);
    return null;
  }

  async function applyClickHouseOutputCharMetrics(client, report, generationId, sourceStats = new Map()) {
    const rows = await clickHouseJsonEachRow(client, clickHouseOutputCharStatsQuery(
      clickHouseGenerationCte("output_char_metrics", "committed_output_char_metrics"),
    ), { params: { generation: generationId } });

    for (const row of rows) {
      const target = row.bucket === "sourceStats"
        ? (sourceStats.get(row.key1) || newStats())
        : outputCharTargetForBucket(report, row);
      if (row.bucket === "sourceStats") sourceStats.set(row.key1, target);
      if (target) mergeOutputCharMetricStats(target, row);
    }
    return sourceStats;
  }

  async function applyClickHouseOutputCharQuantiles(client, report, generationId) {
    const valid = `output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}`;
    const rows = await clickHouseJsonEachRow(client, `
      ${clickHouseGenerationCte("output_char_metrics", "committed_output_char_metrics")}
      SELECT
        'total' AS bucket,
        '' AS effort,
        quantileExactIf(0.10)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP10,
        quantileExactIf(0.99)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP99
      FROM committed_output_char_metrics
      UNION ALL
      SELECT
        'effort' AS bucket,
        effort,
        quantileExactIf(0.10)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP10,
        quantileExactIf(0.99)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP99
      FROM committed_output_char_metrics
      GROUP BY effort
    `, { params: { generation: generationId } });

    for (const row of rows) {
      const target = row.bucket === "total" ? report.total : bucket(report.efforts, row.effort);
      target.outputCharsPerTokenP10 = number(row.outputCharsPerTokenP10);
      target.outputCharsPerTokenP99 = number(row.outputCharsPerTokenP99);
    }
  }

  function parseStoredStats(json) {
    try {
      const parsed = JSON.parse(json);
      return {
        ...newStats(),
        ...parsed,
        costsUsd: {
          ...newCostBreakdown(),
          ...(parsed.costsUsd || {}),
        },
      };
    } catch {
      return newStats();
    }
  }

  function mergeStoredStats(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (key === "costsUsd") {
        for (const [costKey, costValue] of Object.entries(value || {})) {
          target.costsUsd[costKey] = number(target.costsUsd[costKey]) + number(costValue);
        }
      } else if (key.endsWith("Min")) {
        if (value !== null && value !== undefined) {
          target[key] = target[key] === null ? number(value) : Math.min(number(target[key]), number(value));
        }
      } else if (key.endsWith("Max")) {
        if (value !== null && value !== undefined) {
          target[key] = target[key] === null ? number(value) : Math.max(number(target[key]), number(value));
        }
      } else if (!key.endsWith("P10") && !key.endsWith("P99")) {
        target[key] = typeof value === "number"
          ? number(target[key]) + value
          : value ?? target[key];
      }
    }
    return target;
  }

  async function applyClickHouseSessions(client, report, generationId, sourceStats = new Map()) {
    const rows = await clickHouseJsonEachRow(client, `
      WITH ${clickHouseActiveManifestDefinitions()},
      committed_sessions_active AS (
        SELECT sessions.*
        FROM sessions
        INNER JOIN active_manifest AS manifest
          ON manifest.source_path = sessions.source_path
          AND manifest.import_id = sessions.import_id
          AND (
            isNull(manifest.committed_segment_end)
            OR sessions.segment_end <= manifest.committed_segment_end
          )
      ),
      committed_sessions AS (
        SELECT *
        FROM committed_sessions_active
        ORDER BY segment_end DESC
        LIMIT 1 BY source_path, import_id, segment_start, segment_end
      )
      SELECT
        kind, source_path, archive_path, entry_name, size_bytes, compressed_size_bytes,
        started_at, finished_at, duration_ms, lines, records, parse_errors,
        token_count_snapshots, skipped_token_count_snapshots, stats_json
      FROM committed_sessions
      ORDER BY source_path
    `, { params: { generation: generationId } });
    const sessions = new Map();
    for (const row of rows) {
      const existing = sessions.get(row.source_path);
      if (!existing) {
        sessions.set(row.source_path, {
        kind: row.kind,
        path: row.source_path,
        archivePath: row.archive_path || null,
        entryName: row.entry_name || null,
        sizeBytes: number(row.size_bytes),
        compressedSizeBytes: number(row.compressed_size_bytes),
        startedAt: row.started_at || null,
        finishedAt: row.finished_at || null,
        durationMs: number(row.duration_ms),
        lines: number(row.lines),
        records: number(row.records),
        parseErrors: number(row.parse_errors),
        tokenCountSnapshots: number(row.token_count_snapshots),
        skippedTokenCountSnapshots: number(row.skipped_token_count_snapshots),
        stats: parseStoredStats(row.stats_json),
        });
        continue;
      }
      existing.sizeBytes += number(row.size_bytes);
      existing.compressedSizeBytes += number(row.compressed_size_bytes);
      if (row.started_at && (!existing.startedAt || row.started_at < existing.startedAt)) existing.startedAt = row.started_at;
      if (row.finished_at && (!existing.finishedAt || row.finished_at > existing.finishedAt)) existing.finishedAt = row.finished_at;
      existing.durationMs += number(row.duration_ms);
      existing.lines += number(row.lines);
      existing.records += number(row.records);
      existing.parseErrors += number(row.parse_errors);
      existing.tokenCountSnapshots += number(row.token_count_snapshots);
      existing.skippedTokenCountSnapshots += number(row.skipped_token_count_snapshots);
      mergeStoredStats(existing.stats, parseStoredStats(row.stats_json));
    }
    for (const session of sessions.values()) {
      if (sourceStats.has(session.path)) {
        session.stats = {
          ...session.stats,
          ...sourceStats.get(session.path),
        };
      }
      report.sessions.push(session);
    }
  }

  async function applyClickHouseSources(client, report, generationId) {
    const rows = await clickHouseJsonEachRow(client, `
      WITH ${clickHouseActiveManifestDefinitions()}
      SELECT
        uniqExactIf(source.source_path, kind = 'jsonl') AS files,
        uniqExactIf(source.source_path, kind = 'zip-entry') AS zipEntries,
        uniqExactIf(archive_path, kind = 'zip-entry' AND archive_path != '') AS zipFiles
      FROM sources AS source
      INNER JOIN active_manifest AS manifest
        ON manifest.source_path = source.source_path
        AND manifest.import_id = source.import_id
        AND (
          isNull(manifest.committed_segment_end)
          OR source.segment_end <= manifest.committed_segment_end
        )
    `, { params: { generation: generationId } });
    const row = rows[0] || {};
    report.sources.files = number(row.files);
    report.sources.zipEntries = number(row.zipEntries);
    report.sources.zipFiles = number(row.zipFiles);
    report.sources.parseErrors = report.sessions.reduce((sum, session) => sum + number(session.parseErrors), 0);
    report.sources.tokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.tokenCountSnapshots), 0);
    report.sources.skippedTokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.skippedTokenCountSnapshots), 0);
  }

  async function applyClickHouseUnpricedModels(client, report, generationId, configuration) {
    const rows = await clickHouseJsonEachRow(client, `
      ${clickHouseGenerationCte("usage_events", "committed_usage_events", configuration)}
      SELECT provider, model, count() AS requests
      FROM committed_usage_events
      WHERE priced = 0
      GROUP BY provider, model
    `, { params: { generation: generationId, pricingRevision: configuration.settings.pricingRevision } });
    for (const row of rows) {
      const key = `${row.provider}/${row.model}`;
      report.unpricedModels[key] = {
        provider: row.provider,
        model: row.model,
        requests: number(row.requests),
      };
    }
  }

  function clickHouseRateLimitCte(configuration) {
    return `
      WITH ${clickHouseActiveManifestDefinitions()},
      ${clickHouseCommittedRowsDefinition("rate_limit_samples", "committed_rate_limit_samples")},
      repriced_samples AS (
        SELECT
          raw.source_path AS source_path,
          raw.import_id AS import_id,
          raw.line_no AS line_no,
          raw.sample_key AS sample_key,
          raw.group_key AS group_key,
          raw.timestamp_ms AS timestamp_ms,
          raw.date_key AS date_key,
          raw.week_key AS week_key,
          raw.limit_id AS limit_id,
          raw.limit_name AS limit_name,
          raw.plan_type AS plan_type,
          raw.kind AS kind,
          raw.window_minutes AS window_minutes,
          raw.used_percent AS used_percent,
          raw.resets_at AS resets_at,
          raw.reached AS reached,
          raw.agent AS agent,
          raw.effort AS effort,
          raw.model AS model,
          raw.input AS input,
          raw.cache_read AS cache_read,
          raw.output AS output,
          raw.reasoning_output AS reasoning_output,
          if(costs.pricing_revision = '', raw.priced, costs.priced) AS priced,
          if(costs.pricing_revision = '', raw.cost_usd, costs.cost_usd) AS cost_usd,
          if(costs.pricing_revision = '', raw.reasoning_cost_usd, costs.reasoning_cost_usd) AS reasoning_cost_usd,
          raw.group_key AS sample_group_key,
          raw.timestamp_ms AS sample_timestamp_ms,
          raw.sequence AS sample_sequence,
          raw.source_path AS sample_source_path,
          raw.line_no AS sample_line_no
        FROM committed_rate_limit_samples AS raw
        LEFT JOIN rate_limit_sample_costs AS costs
          ON costs.pricing_revision = {pricingRevision:String}
          AND costs.source_path = raw.source_path
          AND costs.import_id = raw.import_id
          AND costs.line_no = raw.line_no
          AND costs.sample_key = raw.sample_key
          AND costs.sequence = raw.sequence
      ),
      ordered AS (
        SELECT
          *,
          lagInFrame(toNullable(timestamp_ms), 1) OVER w AS previous_timestamp_ms,
          lagInFrame(toNullable(resets_at), 1) OVER w AS previous_resets_at,
          lagInFrame(toNullable(used_percent), 1) OVER w AS previous_used_percent
        FROM repriced_samples AS samples
        WINDOW w AS (
          PARTITION BY sample_group_key
          ORDER BY sample_timestamp_ms, sample_sequence, sample_source_path, sample_line_no
          ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING
        )
      ),
      marked AS (
        SELECT
          *,
          if(isNull(previous_timestamp_ms), 1, 0) AS is_first,
          if(
            isNull(previous_resets_at),
            0,
            resets_at = assumeNotNull(previous_resets_at)
              OR (resets_at != 0 AND assumeNotNull(previous_resets_at) != 0
                AND abs(toInt64(resets_at) - toInt64(assumeNotNull(previous_resets_at))) <= 60)
          ) AS same_window,
          if(isNull(previous_timestamp_ms), 0, timestamp_ms - assumeNotNull(previous_timestamp_ms)) AS elapsed_ms,
          (
            isNull(previous_timestamp_ms) = 0
            AND same_window
            AND resets_at != 0
            AND used_percent < assumeNotNull(previous_used_percent)
          ) AS ignored_non_monotonic
        FROM ordered
      ),
      classified AS (
        SELECT
          *,
          (
            is_first = 0
            AND ignored_non_monotonic = 0
            AND (same_window = 0 OR used_percent < assumeNotNull(previous_used_percent))
          ) AS reset_event
        FROM marked
      ),
      deltas AS (
        SELECT
          *,
          if(
            is_first = 0
            AND ignored_non_monotonic = 0
            AND reset_event = 0
            AND used_percent > assumeNotNull(previous_used_percent),
            used_percent - assumeNotNull(previous_used_percent),
            0
          ) AS delta_percent
        FROM classified
      ),
      bucketed AS (
        SELECT 'windows' AS bucket_type, group_key AS bucket_key, '' AS period_type, '' AS period, * FROM deltas
        UNION ALL
        SELECT 'daily' AS bucket_type, concat(agent, '/', date_key, '/', sample_key) AS bucket_key, 'daily' AS period_type, date_key AS period, * FROM deltas
        UNION ALL
        SELECT 'weekly' AS bucket_type, concat(agent, '/', week_key, '/', sample_key) AS bucket_key, 'weekly' AS period_type, week_key AS period, * FROM deltas
      )
    `;
  }

  function rateLimitStatsFromAggregate(row) {
    const stats = newRateLimitStats({
      agent: row.agent || null,
      periodType: row.period_type || null,
      period: row.period || null,
      limitId: row.limit_id || null,
      limitName: row.limit_name || null,
      planType: row.plan_type || null,
      kind: row.kind || null,
      windowMinutes: number(row.window_minutes) || null,
    });
    stats.samples = number(row.samples);
    stats.increases = number(row.increases);
    stats.resets = number(row.resets);
    stats.ignoredNonMonotonic = number(row.ignoredNonMonotonic);
    stats.reached = number(row.reached);
    stats.percentUsedDelta = number(row.percentUsedDelta);
    stats.latestUsedPercent = row.latestUsedPercent == null ? null : number(row.latestUsedPercent);
    stats.latestRemainingPercent = stats.latestUsedPercent == null ? null : Math.max(0, 100 - stats.latestUsedPercent);
    stats.latestAt = row.latestAtMs ? new Date(number(row.latestAtMs)).toISOString() : null;
    stats.latestResetAt = row.latestResetAt == null ? null : number(row.latestResetAt);
    stats.activeMs = number(row.activeMs);
    stats.resetGapMs = number(row.resetGapMs);
    stats.maxResetGapMs = number(row.maxResetGapMs);
    return stats;
  }

  function rateLimitAttributionFromAggregate(row) {
    const stats = newRateLimitAttribution();
    stats.samples = number(row.samples);
    stats.increases = number(row.increases);
    stats.percentUsedDelta = number(row.percentUsedDelta);
    stats.activeMs = number(row.activeMs);
    stats.input = number(row.input);
    stats.cacheRead = number(row.cacheRead);
    stats.output = number(row.output);
    stats.reasoningOutput = number(row.reasoningOutput);
    stats.costUsd = number(row.costUsd);
    stats.reasoningCostUsd = number(row.reasoningCostUsd);
    return stats;
  }

  async function applyClickHouseRateLimits(client, report, generationId, configuration) {
    report.rateLimits = { windows: {}, daily: {}, weekly: {}, planHistory: [] };
    const aggregateRows = await clickHouseJsonEachRow(client, `
      ${clickHouseRateLimitCte(configuration)}
      SELECT
        bucket_type,
        bucket_key,
        grouping(effort, model) AS attributionMask,
        multiIf(
          attributionMask = 3, 'bucket',
          attributionMask = 1, 'effort',
          attributionMask = 2, 'model',
          'model_effort'
        ) AS attr_type,
        multiIf(
          attributionMask = 1, effort,
          attributionMask IN (0, 2), model,
          ''
        ) AS attr_key1,
        if(attributionMask = 0, effort, '') AS attr_key2,
        any(agent) AS agent,
        any(period_type) AS period_type,
        any(period) AS period,
        any(limit_id) AS limit_id,
        any(limit_name) AS limit_name,
        argMaxIf(plan_type, tuple(timestamp_ms, sample_sequence, sample_source_path, sample_line_no), isNotNull(plan_type) AND plan_type != '') AS plan_type,
        any(kind) AS kind,
        any(window_minutes) AS window_minutes,
        count() AS samples,
        sum(reached) AS reached,
        sum(ignored_non_monotonic) AS ignoredNonMonotonic,
        sum(reset_event) AS resets,
        sum(delta_percent > 0) AS increases,
        sum(delta_percent) AS percentUsedDelta,
        sumIf(greatest(0, elapsed_ms), delta_percent > 0) AS activeMs,
        sumIf(elapsed_ms, reset_event AND elapsed_ms > 0) AS resetGapMs,
        maxIf(elapsed_ms, reset_event AND elapsed_ms > 0) AS maxResetGapMs,
        argMaxIf(used_percent, tuple(timestamp_ms, sample_sequence, sample_source_path, sample_line_no), ignored_non_monotonic = 0) AS latestUsedPercent,
        argMaxIf(resets_at, tuple(timestamp_ms, sample_sequence, sample_source_path, sample_line_no), ignored_non_monotonic = 0) AS latestResetAt,
        maxIf(timestamp_ms, ignored_non_monotonic = 0) AS latestAtMs,
        sumIf(input, delta_percent > 0) AS input,
        sumIf(cache_read, delta_percent > 0) AS cacheRead,
        sumIf(output, delta_percent > 0) AS output,
        sumIf(reasoning_output, delta_percent > 0) AS reasoningOutput,
        sumIf(cost_usd, delta_percent > 0) AS costUsd,
        sumIf(reasoning_cost_usd, delta_percent > 0) AS reasoningCostUsd
      FROM bucketed
      GROUP BY GROUPING SETS (
        (bucket_type, bucket_key),
        (bucket_type, bucket_key, effort),
        (bucket_type, bucket_key, model),
        (bucket_type, bucket_key, model, effort)
      )
    `, { params: { generation: generationId, pricingRevision: configuration.settings.pricingRevision } });
    for (const row of aggregateRows) {
      if (row.attr_type !== "bucket") continue;
      report.rateLimits[row.bucket_type][row.bucket_key] = rateLimitStatsFromAggregate(row);
    }

    const planHistoryRows = await clickHouseJsonEachRow(client, `
      ${clickHouseGenerationCte("rate_limit_samples", "committed_rate_limit_samples")}
      SELECT
        date_key AS date,
        agent,
        limit_id,
        plan_type,
        count() AS samples,
        min(timestamp_ms) AS firstObservedAtMs,
        max(timestamp_ms) AS lastObservedAtMs
      FROM committed_rate_limit_samples
      WHERE kind = 'primary' AND isNotNull(plan_type) AND plan_type != ''
      GROUP BY date_key, agent, limit_id, plan_type
      ORDER BY date, agent, limit_id, plan_type
    `, { params: { generation: generationId } });
    report.rateLimits.planHistory = planHistoryRows.map((row) => ({
      date: row.date,
      agent: row.agent,
      limitId: row.limit_id || null,
      planType: row.plan_type,
      samples: number(row.samples),
      firstObservedAt: new Date(number(row.firstObservedAtMs)).toISOString(),
      lastObservedAt: new Date(number(row.lastObservedAtMs)).toISOString(),
    }));

    const providerLimitRows = await clickHouseJsonEachRow(client, `
      ${clickHouseGenerationCte("telemetry_events", "committed_telemetry_events")}
      SELECT timestamp, provider, agent, model, project, raw_json
      FROM committed_telemetry_events
      WHERE event_kind = 'rate_limit_error'
      ORDER BY timestamp_ms, source_path, line_no
    `, { params: { generation: generationId } });
    report.providerLimitEvents = providerLimitRows.map((row) => {
      let payload = {};
      try { payload = JSON.parse(row.raw_json); } catch {}
      return {
        timestamp: row.timestamp,
        provider: row.provider,
        agent: row.agent,
        model: row.model,
        project: row.project,
        message: payload.message || null,
      };
    });

    for (const row of aggregateRows) {
      if (row.attr_type === "bucket") continue;
      if (!report.rateLimits[row.bucket_type]) continue;
      const stats = report.rateLimits[row.bucket_type][row.bucket_key];
      if (!stats) continue;
      const attribution = rateLimitAttributionFromAggregate(row);
      if (row.attr_type === "effort") stats.byEffort[row.attr_key1] = attribution;
      else if (row.attr_type === "model") stats.byModel[row.attr_key1] = attribution;
      else if (row.attr_type === "model_effort") {
        stats.byModelEffort[row.attr_key1] ??= {};
        stats.byModelEffort[row.attr_key1][row.attr_key2] = attribution;
      }
    }
    report._rateLimitFinalized = true;
  }

  async function syncClickHouseDatabase(options) {
    assertSyncDependencies();
    emitSyncProgress(options, { phase: "discovering" });
    const client = clickHouseClient(options);
    if (options.clickhouseReset) {
      await resetClickHouseTables(client);
      logProgress(options, `[clickhouse] reset tables in ${clickHouseLabel(client)}`);
    }
    await initializeClickHouseDatabase(client);
    const configuration = await ensureClickHouseConfiguration(client, options);
    const configuredOptions = pricingOptionsFromConfiguration(options, configuration);
    let committed = await ensureClickHouseBaselineGeneration(client, options);
    const sourceStates = await loadClickHouseGenerationSources(client, committed?.generation_id);
    const inputs = await discoverInputs(configuredOptions);
    const fingerprintForConfiguration = (parts) => sourceFingerprint(parts);
    const { preparedInputs, changedSourcePaths, totalSources } = await prepareStorageInputs(inputs, {
      existingFingerprint: (sourcePath) => sourceStates.get(sourcePath)?.fingerprint || null,
      sourceFingerprint: fingerprintForConfiguration,
    });
    await preflightClickHouseAppendSources(preparedInputs, changedSourcePaths, sourceStates);
    emitSyncProgress(options, {
      phase: "processing",
      totalSources,
      candidateSources: changedSourcePaths.size,
      completedSources: 0,
    });
    logProgress(options, `[clickhouse] changed source candidates=${formatInt(changedSourcePaths.size)}`);
    const persistedCodexSessionHeaders = [
      ...(options.persistedCodexSessionHeaders || []),
      ...await loadClickHouseCodexSessionHeaders(client, committed?.generation_id),
    ];
    const processingOptions = await processingOptionsWithCodexForkRegistry({
      ...configuredOptions,
      codexSourcePaths: changedSourcePaths,
      persistedCodexSessionHeaders,
    }, preparedInputs);
    const limiter = createLimiter(options.limitFiles);
    const changedSources = new Set();
    const manifestChanges = new Set();
    let manifestChanged = false;
    let changed = 0;
    for (const input of preparedInputs) {
      if (input.kind === "jsonl") {
        if (!limiter.take()) continue;
        if (await syncClickHouseJsonlSource(client, input, sourceStates, processingOptions)) {
          changedSources.add(input.path);
          manifestChanges.add(input.path);
          manifestChanged = true;
          changed += 1;
        }
      } else if (input.kind === "zip") {
        const zipResult = await syncClickHouseZipSource(client, input, sourceStates, changedSources, manifestChanges, processingOptions, limiter);
        if (zipResult.manifestChanged) manifestChanged = true;
        changed += zipResult.changed;
      }
    }
    if (removeSupersededClickHouseSources(
      sourceStates,
      changedSources,
      manifestChanges,
      processingOptions.codexForkRegistry?.currentHeaders,
      persistedCodexSessionHeaders,
    ) > 0) {
      manifestChanged = true;
    }
    if (manifestChanged) {
      await storeClickHouseCodexSessionHeaders(
        client,
        processingOptions.codexForkRegistry?.currentHeaders,
        sourceStates,
        changedSources,
        processingOptions,
      );
      const checkpointManifest = !committed || (
        await clickHouseManifestDeltaGenerations(client, committed.generation_id)
        >= CLICKHOUSE_MANIFEST_CHECKPOINT_INTERVAL
      );
      committed = await commitClickHouseGeneration(
        client,
        sourceStates,
        committed?.committed_at_ms,
        committed?.generation_id,
        processingOptions,
        manifestChanges,
        checkpointManifest,
      );
    }
    emitSyncProgress(options, {
      phase: "finalizing",
      totalSources,
      candidateSources: changedSourcePaths.size,
      completedSources: changed,
      changedSources: changed,
    });
    const report = await buildReportFromClickHouse(options, committed?.generation_id);
    logProgress(options, `[clickhouse] ${clickHouseLabel(client)} changed_sources=${formatInt(changed)} sessions=${formatInt(report.sessions.length)}`);
    return report;
  }

  async function buildReportFromClickHouse(options = {}, pinnedGenerationId = null) {
    const client = clickHouseClient(options);
    await initializeClickHouseDatabase(client);
    const configuration = await ensureClickHouseConfiguration(client, options);
    const generationId = pinnedGenerationId
      || (await ensureClickHouseBaselineGeneration(client, options))?.generation_id
      || "";
    const report = newReport();
    const sourceStats = await applyClickHouseUsageStats(client, report, generationId, configuration);
    await applyClickHouseOutputCharMetrics(client, report, generationId, sourceStats);
    await applyClickHouseOutputCharQuantiles(client, report, generationId);
    await applyClickHouseSessions(client, report, generationId, sourceStats);
    await applyClickHouseSources(client, report, generationId);
    await applyClickHouseUnpricedModels(client, report, generationId, configuration);
    await applyClickHouseRateLimits(client, report, generationId, configuration);
    report.configurationRevision = configuration.revision;
    report.pricingRevision = configuration.settings.pricingRevision;
    report.pricingBasis = configuration.settings.pricingBasis;
    report.regionalMultiplier = configuration.settings.regionalMultiplier;
    report.monthlyCostLimitUsd = configuration.settings.monthlyCostLimitUsd;
    report.usageProfile = configuration.settings.usageProfile;
    report.pricingStale = false;
    return report;
  }
  return {
    buildReportFromClickHouse,
    loadConfiguration: loadClickHouseConfiguration,
    saveConfiguration: saveClickHouseConfiguration,
    syncClickHouseDatabase,
  };
}

module.exports = {
  DEFAULT_CLICKHOUSE_DATABASE,
  DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES,
  DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS,
  DEFAULT_CLICKHOUSE_URL,
  createClickHouseBackend,
  parseByteSize,
};
