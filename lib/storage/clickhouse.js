"use strict";

const fsp = require("node:fs/promises");
const { randomUUID } = require("node:crypto");
const { URL } = require("node:url");
const { listZipEntries } = require("../ingest/archive");
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
  weekKey,
  yearKey,
} = require("../core/report-model");
const { normalizeCodexUuid } = require("../core/usage");
const { emitSyncProgress } = require("../core/sync-progress");
const { newRateLimitAttribution, newRateLimitStats } = require("../core/rate-limits");
const { prepareStorageInputs } = require("./source-preflight");

const DEFAULT_CLICKHOUSE_URL = "http://127.0.0.1:8123";
const DEFAULT_CLICKHOUSE_DATABASE = "tokenomics";
const DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS = 100_000;
const DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES = 32 * 1024 * 1024;
const CLICKHOUSE_SOURCE_TABLES = ["rate_limit_samples", "output_char_metrics", "usage_events", "sessions", "codex_sessions"];

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
        imported_at String CODEC(ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY source_path
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
        stats_json String CODEC(ZSTD(6))
      ) ENGINE = MergeTree
      ORDER BY source_path
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS usage_events (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
        line_no UInt64 CODEC(Delta, ZSTD(1)),
        timestamp Nullable(String) CODEC(ZSTD(1)),
        date_key String CODEC(ZSTD(1)),
        week_key String CODEC(ZSTD(1)),
        month_key String CODEC(ZSTD(1)),
        year_key String CODEC(ZSTD(1)),
        provider LowCardinality(String) CODEC(ZSTD(1)),
        model String CODEC(ZSTD(3)),
        project String CODEC(ZSTD(3)),
        effort LowCardinality(String) CODEC(ZSTD(1)),
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
      CREATE TABLE IF NOT EXISTS rate_limit_samples (
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3)),
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
      CREATE TABLE IF NOT EXISTS import_generation_sources (
        generation_id String CODEC(ZSTD(3)),
        source_path String CODEC(ZSTD(3)),
        import_id String CODEC(ZSTD(3))
      ) ENGINE = MergeTree
      ORDER BY (generation_id, source_path)
    `);
    await clickHouseRequest(client, `
      CREATE TABLE IF NOT EXISTS import_generations (
        generation_id String CODEC(ZSTD(3)),
        committed_at_ms UInt64 CODEC(Delta, ZSTD(1))
      ) ENGINE = MergeTree
      ORDER BY (committed_at_ms, generation_id)
    `);
    await clickHouseRequest(client, `
      ALTER TABLE sources
        ADD COLUMN IF NOT EXISTS import_id String DEFAULT '' CODEC(ZSTD(3))
    `);
    for (const table of ["codex_sessions", "sessions", "output_char_metrics", "rate_limit_samples"]) {
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
    };
  }

  function clickHouseSourceFingerprint(parts) {
    return Object.entries(parts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => String(key) + "=" + (value ?? ""))
      .join("|");
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

  async function loadClickHouseGenerationSources(client, generationId) {
    if (!generationId) return new Map();
    const rows = await clickHouseJsonEachRow(client, `
      SELECT
        manifest.source_path AS source_path,
        manifest.import_id AS import_id,
        argMax(source.fingerprint, source.imported_at) AS fingerprint
      FROM import_generation_sources AS manifest
      INNER JOIN sources AS source USING (source_path, import_id)
      WHERE manifest.generation_id = {generation:String}
      GROUP BY manifest.source_path, manifest.import_id
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

  async function commitClickHouseGeneration(client, sourceStates, previousCommitMs, options = {}) {
    const generationId = randomUUID();
    const manifestRows = [...sourceStates.values()].map((state) => ({
      generation_id: generationId,
      source_path: state.source_path,
      import_id: state.import_id || "",
    }));
    await clickHouseInsertRows(client, "import_generation_sources", manifestRows, options);
    const committedAtMs = Math.max(Date.now(), number(previousCommitMs) + 1);
    await clickHouseInsertRows(client, "import_generations", [{
      generation_id: generationId,
      committed_at_ms: committedAtMs,
    }], options);
    return { generation_id: generationId, committed_at_ms: committedAtMs };
  }

  async function ensureClickHouseBaselineGeneration(client, options = {}) {
    const committed = await latestClickHouseGeneration(client);
    if (committed) return committed;
    const legacySources = await loadLegacyClickHouseSources(client);
    if (legacySources.size === 0) return null;
    return commitClickHouseGeneration(client, legacySources, 0, options);
  }

  async function loadClickHouseCodexSessionHeaders(client, generationId) {
    if (!generationId) return [];
    return clickHouseJsonEachRow(client, `
      SELECT
        session_id,
        argMax(parent_session_id, updated_at_ms) AS parent_session_id,
        argMax(source_path, updated_at_ms) AS source_path,
        argMax(kind, updated_at_ms) AS kind,
        argMax(archive_path, updated_at_ms) AS archive_path,
        argMax(entry_name, updated_at_ms) AS entry_name
      FROM (
        SELECT
          session_id, parent_session_id, source_path, import_id,
          kind, archive_path, entry_name, updated_at_ms
        FROM codex_session_versions
        UNION ALL
        SELECT
          session_id, parent_session_id, source_path, import_id,
          kind, archive_path, entry_name, updated_at_ms
        FROM codex_sessions
      ) AS headers
      INNER JOIN import_generation_sources AS manifest USING (source_path, import_id)
      WHERE manifest.generation_id = {generation:String}
      GROUP BY session_id
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
      updated_at_ms: Date.parse(row.updatedAt),
    }));
    await clickHouseInsertRows(client, "codex_session_versions", rows, options);
  }

  function clickHouseSessionRow(session, importId) {
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
      stats_json: JSON.stringify(session.stats),
    };
  }

  function clickHouseUsageEventRow(event, defaultSourcePath, importId) {
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
    return {
      source_path: event.sourcePath || defaultSourcePath,
      import_id: importId,
      line_no: number(event.lineNo),
      timestamp: event.timestamp || null,
      date_key: dateKey(timestamp),
      week_key: weekKey(timestamp),
      month_key: monthKey(timestamp),
      year_key: yearKey(timestamp),
      provider: event.provider,
      model: event.model,
      project: event.project,
      effort: event.effort,
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

  function clickHouseRateLimitSampleRow(sample, defaultSourcePath, importId) {
    const timestamp = new Date(sample.timestampMs);
    return {
      source_path: sample.sourcePath || defaultSourcePath,
      import_id: importId,
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
    const importId = randomUUID();
    const usageSink = createClickHouseRowSink(client, "usage_events", options);
    const outputCharMetricSink = createClickHouseRowSink(client, "output_char_metrics", options);
    const rateLimitSink = createClickHouseRowSink(client, "rate_limit_samples", options);
    const report = newReport();
    report._usageEventSink = (event) => usageSink.push(clickHouseUsageEventRow(event, source.path, importId));
    report._outputCharMetricSink = (event) => outputCharMetricSink.push(clickHouseOutputCharMetricRow(event, source.path, importId));
    report._rateLimitSampleSink = (sample) => rateLimitSink.push(clickHouseRateLimitSampleRow(sample, source.path, importId));
    report._afterLine = () => drainClickHouseSinks([usageSink, outputCharMetricSink, rateLimitSink]);

    if (source.kind === "jsonl") {
      await processJsonlFile(source.path, report, options);
    } else if (source.kind === "zip-entry") {
      await processZipEntry(source.archivePath, source.entry, report, options);
    } else {
      throw new Error(`Unsupported ClickHouse source kind: ${source.kind}`);
    }

    await usageSink.finish();
    await outputCharMetricSink.finish();
    await rateLimitSink.finish();
    await clickHouseInsertRows(client, "sessions", report.sessions.map((session) => clickHouseSessionRow(session, importId)), options);
    // Insert the marker only after every source-owned table has been written.
    await clickHouseInsertRows(client, "sources", [clickHouseSourceRow(source, fingerprint, importId)], options);
    return {
      report,
      sourceState: {
        source_path: source.path,
        import_id: importId,
        fingerprint,
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

  async function syncClickHouseJsonlSource(client, input, sourceStates, options) {
    const stat = input.stat || await fsp.stat(input.path);
    const fingerprint = clickHouseSourceFingerprint({
      kind: "jsonl",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    const sourceState = sourceStates.get(input.path);
    // An unchanged source is already committed and must not enter cleanup.
    if (sourceState?.fingerprint === fingerprint) return false;

    const source = {
      kind: "jsonl",
      path: input.path,
      sizeBytes: stat.size,
    };
    const staged = await processAndStoreClickHouseSource(client, source, fingerprint, options);
    sourceStates.set(input.path, staged.sourceState);
    return staged.sourceState;
  }

  async function syncClickHouseZipSource(client, input, sourceStates, changedSources, options, limiter) {
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
        removed += 1;
      }
    }

    let changed = 0;
    for (const entry of entries) {
      if (!limiter.take()) continue;
      const sourcePath = `${input.path}:${entry.fileName}`;
      const fingerprint = clickHouseSourceFingerprint({
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
      if (sourceState?.fingerprint === fingerprint) continue;

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

  function clickHouseGenerationJoin(table, alias = table) {
    return `
      FROM ${table} AS ${alias}
      INNER JOIN import_generation_sources AS manifest
        ON manifest.source_path = ${alias}.source_path
        AND manifest.import_id = ${alias}.import_id
      WHERE manifest.generation_id = {generation:String}
    `;
  }

  function clickHouseGenerationCte(table, name) {
    return `
      WITH ${name} AS (
        SELECT raw.*
        FROM ${table} AS raw
        INNER JOIN import_generation_sources AS manifest
          ON manifest.source_path = raw.source_path
          AND manifest.import_id = raw.import_id
        WHERE manifest.generation_id = {generation:String}
      )
    `;
  }

  function clickHouseStatsSelect(bucketName, key1Expr, key2Expr = "''", groupBy = "") {
    return `
      SELECT
        '${bucketName}' AS bucket,
        ${key1Expr} AS key1,
        ${key2Expr} AS key2,
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
      FROM committed_usage_events AS usage_events
      ${groupBy}
    `;
  }

  async function applyClickHouseUsageStats(client, report, generationId) {
    const rows = await clickHouseJsonEachRow(client, clickHouseGenerationCte("usage_events", "committed_usage_events") + [
      clickHouseStatsSelect("total", "''"),
      clickHouseStatsSelect("daily", "date_key", "''", "GROUP BY date_key"),
      clickHouseStatsSelect("weekly", "week_key", "''", "GROUP BY week_key"),
      clickHouseStatsSelect("monthly", "month_key", "''", "GROUP BY month_key"),
      clickHouseStatsSelect("yearly", "year_key", "''", "GROUP BY year_key"),
      clickHouseStatsSelect("providers", "provider", "''", "GROUP BY provider"),
      clickHouseStatsSelect("models", "model", "''", "GROUP BY model"),
      clickHouseStatsSelect("providerModels", "concat(provider, '/', model)", "''", "GROUP BY provider, model"),
      clickHouseStatsSelect("projects", "project", "''", "GROUP BY project"),
      clickHouseStatsSelect("projectDaily", "project", "date_key", "GROUP BY project, date_key"),
      clickHouseStatsSelect("projectModels", "project", "model", "GROUP BY project, model"),
      clickHouseStatsSelect("efforts", "effort", "''", "GROUP BY effort"),
      clickHouseStatsSelect("modelEfforts", "model", "effort", "GROUP BY model, effort"),
    ].join("\nUNION ALL\n"), { params: { generation: generationId } });

    for (const row of rows) {
      const stats = aggregateStatsFromRow(row);
      if (row.bucket === "total") report.total = stats;
      else if (row.bucket === "daily") report.daily[row.key1] = stats;
      else if (row.bucket === "weekly") report.weekly[row.key1] = stats;
      else if (row.bucket === "monthly") report.monthly[row.key1] = stats;
      else if (row.bucket === "yearly") report.yearly[row.key1] = stats;
      else if (row.bucket === "providers") report.providers[row.key1] = stats;
      else if (row.bucket === "models") report.models[row.key1] = stats;
      else if (row.bucket === "providerModels") report.providerModels[row.key1] = stats;
      else if (row.bucket === "projects") report.projects[row.key1] = stats;
      else if (row.bucket === "projectDaily") {
        report.projectDaily[row.key1] ??= {};
        report.projectDaily[row.key1][row.key2] = stats;
      }
      else if (row.bucket === "projectModels") {
        report.projectModels[row.key1] ??= {};
        report.projectModels[row.key1][row.key2] = stats;
      } else if (row.bucket === "efforts") report.efforts[row.key1] = stats;
      else if (row.bucket === "modelEfforts") {
        report.modelEfforts[row.key1] ??= {};
        report.modelEfforts[row.key1][row.key2] = stats;
      }
    }
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

  function clickHouseOutputCharStatsSelect(bucketName, key1Expr, key2Expr = "''", groupBy = "") {
    return `
      SELECT
        '${bucketName}' AS bucket,
        ${key1Expr} AS key1,
        ${key2Expr} AS key2,
        sumIf(visible_output_chars, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS visibleOutputTextChars,
        sumIf(visible_output_tokens, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS visibleOutputTextTokens,
        countIf(output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharTokenSamples,
        sumIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenSum,
        minIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenMin,
        maxIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenMax,
        countIf(output_chars_per_token > ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharTokenOutliers
      FROM committed_output_char_metrics AS output_char_metrics
      ${groupBy}
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

  async function applyClickHouseOutputCharMetrics(client, report, generationId) {
    const rows = await clickHouseJsonEachRow(client, clickHouseGenerationCte("output_char_metrics", "committed_output_char_metrics") + [
      clickHouseOutputCharStatsSelect("total", "''"),
      clickHouseOutputCharStatsSelect("daily", "date_key", "''", "GROUP BY date_key"),
      clickHouseOutputCharStatsSelect("weekly", "week_key", "''", "GROUP BY week_key"),
      clickHouseOutputCharStatsSelect("monthly", "month_key", "''", "GROUP BY month_key"),
      clickHouseOutputCharStatsSelect("yearly", "year_key", "''", "GROUP BY year_key"),
      clickHouseOutputCharStatsSelect("providers", "provider", "''", "GROUP BY provider"),
      clickHouseOutputCharStatsSelect("models", "model", "''", "GROUP BY model"),
      clickHouseOutputCharStatsSelect("providerModels", "concat(provider, '/', model)", "''", "GROUP BY provider, model"),
      clickHouseOutputCharStatsSelect("projects", "project", "''", "GROUP BY project"),
      clickHouseOutputCharStatsSelect("projectDaily", "project", "date_key", "GROUP BY project, date_key"),
      clickHouseOutputCharStatsSelect("projectModels", "project", "model", "GROUP BY project, model"),
      clickHouseOutputCharStatsSelect("efforts", "effort", "''", "GROUP BY effort"),
      clickHouseOutputCharStatsSelect("modelEfforts", "model", "effort", "GROUP BY model, effort"),
    ].join("\nUNION ALL\n"), { params: { generation: generationId } });

    for (const row of rows) {
      const target = outputCharTargetForBucket(report, row);
      if (target) mergeOutputCharMetricStats(target, row);
    }
  }

  async function applyClickHouseOutputCharQuantiles(client, report, generationId) {
    const valid = `output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}`;
    const rows = await clickHouseJsonEachRow(client, `
      ${clickHouseGenerationCte("output_char_metrics", "committed_output_char_metrics")}
      SELECT
        'total' AS bucket,
        '' AS effort,
        quantileTDigestIf(0.10)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP10,
        quantileTDigestIf(0.99)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP99
      FROM committed_output_char_metrics
      UNION ALL
      SELECT
        'effort' AS bucket,
        effort,
        quantileTDigestIf(0.10)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP10,
        quantileTDigestIf(0.99)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP99
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

  async function applyClickHouseSessions(client, report, generationId) {
    const rows = await clickHouseJsonEachRow(client, `
      SELECT
        kind, source_path, archive_path, entry_name, size_bytes, compressed_size_bytes,
        started_at, finished_at, duration_ms, lines, records, parse_errors,
        token_count_snapshots, skipped_token_count_snapshots, stats_json
      ${clickHouseGenerationJoin("sessions")}
      ORDER BY source_path
    `, { params: { generation: generationId } });
    for (const row of rows) {
      report.sessions.push({
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
    }
  }

  async function applyClickHouseSources(client, report, generationId) {
    const rows = await clickHouseJsonEachRow(client, `
      SELECT
        countIf(kind = 'jsonl') AS files,
        countIf(kind = 'zip-entry') AS zipEntries,
        uniqExactIf(archive_path, kind = 'zip-entry' AND archive_path != '') AS zipFiles
      FROM sources AS source
      INNER JOIN import_generation_sources AS manifest
        ON manifest.source_path = source.source_path
        AND manifest.import_id = source.import_id
      WHERE manifest.generation_id = {generation:String}
    `, { params: { generation: generationId } });
    const row = rows[0] || {};
    report.sources.files = number(row.files);
    report.sources.zipEntries = number(row.zipEntries);
    report.sources.zipFiles = number(row.zipFiles);
    report.sources.parseErrors = report.sessions.reduce((sum, session) => sum + number(session.parseErrors), 0);
    report.sources.tokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.tokenCountSnapshots), 0);
    report.sources.skippedTokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.skippedTokenCountSnapshots), 0);
  }

  async function applyClickHouseUnpricedModels(client, report, generationId) {
    const rows = await clickHouseJsonEachRow(client, `
      SELECT provider, model, count() AS requests
      ${clickHouseGenerationJoin("usage_events")}
        AND priced = 0
      GROUP BY provider, model
    `, { params: { generation: generationId } });
    for (const row of rows) {
      const key = `${row.provider}/${row.model}`;
      report.unpricedModels[key] = {
        provider: row.provider,
        model: row.model,
        requests: number(row.requests),
      };
    }
  }

  function clickHouseRateLimitCte() {
    return `
      WITH
      ordered AS (
        SELECT
          *,
          lagInFrame(toNullable(timestamp_ms), 1) OVER w AS previous_timestamp_ms,
          lagInFrame(toNullable(resets_at), 1) OVER w AS previous_resets_at,
          lagInFrame(toNullable(used_percent), 1) OVER w AS previous_used_percent
        FROM (
          SELECT raw_samples.*
          FROM rate_limit_samples AS raw_samples
          INNER JOIN import_generation_sources AS manifest
            ON manifest.source_path = raw_samples.source_path
            AND manifest.import_id = raw_samples.import_id
          WHERE manifest.generation_id = {generation:String}
        )
        WINDOW w AS (
          PARTITION BY group_key
          ORDER BY timestamp_ms, sequence, source_path, line_no
          ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING
        )
      ),
      marked AS (
        SELECT
          *,
          if(isNull(previous_timestamp_ms), 1, 0) AS is_first,
          ifNull(resets_at = previous_resets_at, 0) AS same_window,
          if(isNull(previous_timestamp_ms), 0, timestamp_ms - assumeNotNull(previous_timestamp_ms)) AS elapsed_ms,
          (
            isNull(previous_timestamp_ms) = 0
            AND ifNull(resets_at = previous_resets_at, 0)
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

  async function applyClickHouseRateLimits(client, report, generationId) {
    report.rateLimits = { windows: {}, daily: {}, weekly: {} };
    const bucketRows = await clickHouseJsonEachRow(client, `
      ${clickHouseRateLimitCte()}
      SELECT
        bucket_type,
        bucket_key,
        any(agent) AS agent,
        any(period_type) AS period_type,
        any(period) AS period,
        any(limit_id) AS limit_id,
        any(limit_name) AS limit_name,
        any(plan_type) AS plan_type,
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
        argMax(used_percent, tuple(timestamp_ms, sequence, source_path, line_no)) AS latestUsedPercent,
        max(timestamp_ms) AS latestAtMs
      FROM bucketed
      GROUP BY bucket_type, bucket_key
    `, { params: { generation: generationId } });
    for (const row of bucketRows) {
      report.rateLimits[row.bucket_type][row.bucket_key] = rateLimitStatsFromAggregate(row);
    }

    const attributionRows = await clickHouseJsonEachRow(client, `
      ${clickHouseRateLimitCte()}
      SELECT
        bucket_type,
        bucket_key,
        attr_type,
        attr_key1,
        attr_key2,
        count() AS samples,
        sum(delta_percent > 0) AS increases,
        sum(delta_percent) AS percentUsedDelta,
        sumIf(greatest(0, elapsed_ms), delta_percent > 0) AS activeMs,
        sumIf(input, delta_percent > 0) AS input,
        sumIf(cache_read, delta_percent > 0) AS cacheRead,
        sumIf(output, delta_percent > 0) AS output,
        sumIf(reasoning_output, delta_percent > 0) AS reasoningOutput,
        sumIf(cost_usd, delta_percent > 0) AS costUsd,
        sumIf(reasoning_cost_usd, delta_percent > 0) AS reasoningCostUsd
      FROM (
        SELECT bucket_type, bucket_key, 'effort' AS attr_type, effort AS attr_key1, '' AS attr_key2, * FROM bucketed
        UNION ALL
        SELECT bucket_type, bucket_key, 'model' AS attr_type, model AS attr_key1, '' AS attr_key2, * FROM bucketed
        UNION ALL
        SELECT bucket_type, bucket_key, 'model_effort' AS attr_type, model AS attr_key1, effort AS attr_key2, * FROM bucketed
      )
      GROUP BY bucket_type, bucket_key, attr_type, attr_key1, attr_key2
    `, { params: { generation: generationId } });
    for (const row of attributionRows) {
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
    let committed = await ensureClickHouseBaselineGeneration(client, options);
    const sourceStates = await loadClickHouseGenerationSources(client, committed?.generation_id);
    const inputs = await discoverInputs(options);
    const { preparedInputs, changedSourcePaths, totalSources } = await prepareStorageInputs(inputs, {
      existingFingerprint: (sourcePath) => sourceStates.get(sourcePath)?.fingerprint || null,
      sourceFingerprint: clickHouseSourceFingerprint,
    });
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
      ...options,
      codexSourcePaths: changedSourcePaths,
      persistedCodexSessionHeaders,
    }, preparedInputs);
    const limiter = createLimiter(options.limitFiles);
    const changedSources = new Set();
    let manifestChanged = false;
    let changed = 0;
    for (const input of preparedInputs) {
      if (input.kind === "jsonl") {
        if (!limiter.take()) continue;
        if (await syncClickHouseJsonlSource(client, input, sourceStates, processingOptions)) {
          changedSources.add(input.path);
          manifestChanged = true;
          changed += 1;
        }
      } else if (input.kind === "zip") {
        const zipResult = await syncClickHouseZipSource(client, input, sourceStates, changedSources, processingOptions, limiter);
        if (zipResult.manifestChanged) manifestChanged = true;
        changed += zipResult.changed;
      }
    }
    if (manifestChanged) {
      await storeClickHouseCodexSessionHeaders(
        client,
        processingOptions.codexForkRegistry?.currentHeaders,
        sourceStates,
        changedSources,
        processingOptions,
      );
      committed = await commitClickHouseGeneration(
        client,
        sourceStates,
        committed?.committed_at_ms,
        processingOptions,
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
    const generationId = pinnedGenerationId
      || (await ensureClickHouseBaselineGeneration(client, options))?.generation_id
      || "";
    const report = newReport();
    await applyClickHouseUsageStats(client, report, generationId);
    await applyClickHouseOutputCharMetrics(client, report, generationId);
    await applyClickHouseOutputCharQuantiles(client, report, generationId);
    await applyClickHouseSessions(client, report, generationId);
    await applyClickHouseSources(client, report, generationId);
    await applyClickHouseUnpricedModels(client, report, generationId);
    await applyClickHouseRateLimits(client, report, generationId);
    return report;
  }
  return {
    buildReportFromClickHouse,
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
