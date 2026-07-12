"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { listZipEntries } = require("../ingest/archive");
const {
  MAX_VALID_OUTPUT_CHARS_PER_TOKEN,
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
  addOutputCharTokenMetric,
  addToStats,
  bucket,
  dateKey,
  monthKey,
  nestedBucket,
  newCostBreakdown,
  newReport,
  newStats,
  normalizeEffort,
  normalizeVisibleChars,
  number,
  weekKey,
  yearKey,
} = require("../core/report-model");
const { normalizeCodexUuid } = require("../core/usage");
const { emitSyncProgress } = require("../core/sync-progress");
const {
  addRateLimitDelta,
  rateLimitPeriodInfo,
  touchRateLimitStats,
} = require("../core/rate-limits");
const { prepareStorageInputs } = require("./source-preflight");

const DEFAULT_DB_FILENAME = "tokenomics.sqlite";

function createSqliteBackend(dependencies = {}) {
  const {
    createLimiter,
    discoverInputs,
    formatBytes,
    formatInt,
    logProgress,
    processJsonlFile,
    processZipEntry,
    processingOptionsWithCodexForkRegistry,
  } = dependencies;
  const progress = typeof logProgress === "function" ? logProgress : () => {};
  const formatSize = typeof formatBytes === "function" ? formatBytes : String;
  const formatNumber = typeof formatInt === "function" ? formatInt : String;

  function resolveDbPath(options = {}) {
    return Path.resolve(options.db || Path.join(process.cwd(), DEFAULT_DB_FILENAME));
  }

  function ensureSqliteColumn(db, table, column, definition) {
    const columns = db.prepare("PRAGMA table_info(" + table + ")").all();
    if (columns.some((existing) => existing.name === column)) return;
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
  }

  function openTokenomicsDatabase(dbPath) {
    fs.mkdirSync(Path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        source_path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        archive_path TEXT,
        entry_name TEXT,
        fingerprint TEXT NOT NULL,
        size_bytes INTEGER,
        compressed_size_bytes INTEGER,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_sessions (
        session_id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        source_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        archive_path TEXT,
        entry_name TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        source_path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        archive_path TEXT,
        entry_name TEXT,
        size_bytes INTEGER,
        compressed_size_bytes INTEGER,
        started_at TEXT,
        finished_at TEXT,
        duration_ms REAL NOT NULL,
        lines INTEGER NOT NULL,
        records INTEGER NOT NULL,
        parse_errors INTEGER NOT NULL,
        token_count_snapshots INTEGER NOT NULL,
        skipped_token_count_snapshots INTEGER NOT NULL,
        stats_json TEXT NOT NULL,
        FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        line_no INTEGER,
        timestamp TEXT,
        date_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        year_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        project TEXT NOT NULL,
        effort TEXT NOT NULL,
        input INTEGER NOT NULL,
        cache_create_5m INTEGER NOT NULL,
        cache_create_30m INTEGER NOT NULL DEFAULT 0,
        cache_create_1h INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning_output INTEGER NOT NULL,
        context_window INTEGER NOT NULL,
        priced INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        reasoning_cost_usd REAL NOT NULL,
        cost_input_usd REAL NOT NULL,
        cost_cache_create_5m_usd REAL NOT NULL,
        cost_cache_create_30m_usd REAL NOT NULL DEFAULT 0,
        cost_cache_create_1h_usd REAL NOT NULL,
        cost_cache_read_usd REAL NOT NULL,
        cost_output_usd REAL NOT NULL,
        visible_input_chars INTEGER NOT NULL DEFAULT 0,
        visible_output_chars INTEGER NOT NULL DEFAULT 0,
        visible_total_chars INTEGER NOT NULL DEFAULT 0,
        visible_chars_per_token REAL NOT NULL DEFAULT 0,
        FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS output_char_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        turn_id TEXT,
        timestamp TEXT,
        date_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        year_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        project TEXT NOT NULL,
        effort TEXT NOT NULL,
        visible_output_chars INTEGER NOT NULL,
        visible_output_tokens INTEGER NOT NULL,
        output_chars_per_token REAL NOT NULL,
        FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS rate_limit_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT,
        line_no INTEGER,
        sample_key TEXT NOT NULL,
        group_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        limit_id TEXT,
        limit_name TEXT,
        plan_type TEXT,
        kind TEXT NOT NULL,
        window_minutes INTEGER,
        used_percent REAL NOT NULL,
        resets_at INTEGER NOT NULL,
        reached INTEGER NOT NULL,
        agent TEXT NOT NULL,
        effort TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning_output INTEGER NOT NULL,
        priced INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        reasoning_cost_usd REAL NOT NULL,
        FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
      CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project);
      CREATE INDEX IF NOT EXISTS idx_output_char_metrics_time ON output_char_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_rate_limit_samples_group_time ON rate_limit_samples(group_key, timestamp_ms, sequence);
      CREATE INDEX IF NOT EXISTS idx_codex_sessions_parent ON codex_sessions(parent_session_id);
    `);
    ensureSqliteColumn(db, "usage_events", "visible_input_chars", "INTEGER NOT NULL DEFAULT 0");
    ensureSqliteColumn(db, "usage_events", "cache_create_30m", "INTEGER NOT NULL DEFAULT 0");
    ensureSqliteColumn(db, "usage_events", "cost_cache_create_30m_usd", "REAL NOT NULL DEFAULT 0");
    ensureSqliteColumn(db, "usage_events", "visible_output_chars", "INTEGER NOT NULL DEFAULT 0");
    ensureSqliteColumn(db, "usage_events", "visible_total_chars", "INTEGER NOT NULL DEFAULT 0");
    ensureSqliteColumn(db, "usage_events", "visible_chars_per_token", "REAL NOT NULL DEFAULT 0");
    db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1')").run();
    return db;
  }

  async function withAsyncTransaction(db, fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function sourceFingerprint(parts) {
    return Object.entries(parts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => String(key) + "=" + (value ?? ""))
      .join("|");
  }

  function codexSessionStorageRows(headers, updatedAt = new Date().toISOString()) {
    const rowsBySession = new Map();
    for (const header of headers || []) {
      const sessionId = normalizeCodexUuid(header?.id);
      const source = header?.source;
      if (!sessionId || !source?.sourcePath || !source.kind) continue;
      rowsBySession.set(sessionId, {
        sessionId,
        parentSessionId: normalizeCodexUuid(header.forkedFromId),
        sourcePath: source.sourcePath,
        kind: source.kind,
        archivePath: source.archivePath || null,
        entryName: source.entryName || null,
        updatedAt,
      });
    }
    return [...rowsBySession.values()];
  }

  function loadSqliteCodexSessionHeaders(db) {
    return db.prepare(`
      SELECT session_id, parent_session_id, source_path, kind, archive_path, entry_name
      FROM codex_sessions
    `).all();
  }

  function storeSqliteCodexSessionHeaders(db, headers) {
    const rows = codexSessionStorageRows(headers);
    if (rows.length === 0) return;
    const deleteBySource = db.prepare("DELETE FROM codex_sessions WHERE source_path = ?");
    const insert = db.prepare(`
      INSERT INTO codex_sessions(
        session_id, parent_session_id, source_path, kind, archive_path, entry_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        parent_session_id = excluded.parent_session_id,
        source_path = excluded.source_path,
        kind = excluded.kind,
        archive_path = excluded.archive_path,
        entry_name = excluded.entry_name,
        updated_at = excluded.updated_at
    `);
    for (const row of rows) {
      deleteBySource.run(row.sourcePath);
      insert.run(
        row.sessionId,
        row.parentSessionId,
        row.sourcePath,
        row.kind,
        row.archivePath,
        row.entryName,
        row.updatedAt,
      );
    }
  }

  function existingSourceFingerprint(db, sourcePath) {
    const row = db.prepare("SELECT fingerprint FROM sources WHERE source_path = ?").get(sourcePath);
    return row?.fingerprint || null;
  }

  function deleteSourceRows(db, sourcePath) {
    db.prepare("DELETE FROM usage_events WHERE source_path = ?").run(sourcePath);
    db.prepare("DELETE FROM output_char_metrics WHERE source_path = ?").run(sourcePath);
    db.prepare("DELETE FROM rate_limit_samples WHERE source_path = ?").run(sourcePath);
    db.prepare("DELETE FROM sessions WHERE source_path = ?").run(sourcePath);
    db.prepare("DELETE FROM codex_sessions WHERE source_path = ?").run(sourcePath);
    db.prepare("DELETE FROM sources WHERE source_path = ?").run(sourcePath);
  }

  function prepareSourceStatements(db) {
    return {
      insertSource: db.prepare(`
        INSERT INTO sources(source_path, kind, archive_path, entry_name, fingerprint, size_bytes, compressed_size_bytes, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertSession: db.prepare(`
        INSERT INTO sessions(
          source_path, kind, archive_path, entry_name, size_bytes, compressed_size_bytes,
          started_at, finished_at, duration_ms, lines, records, parse_errors,
          token_count_snapshots, skipped_token_count_snapshots, stats_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertUsage: db.prepare(`
        INSERT INTO usage_events(
          source_path, line_no, timestamp, date_key, week_key, month_key, year_key,
          provider, model, project, effort,
          input, cache_create_5m, cache_create_30m, cache_create_1h, cache_read, output, reasoning_output,
          context_window, priced, cost_usd, reasoning_cost_usd,
          cost_input_usd, cost_cache_create_5m_usd, cost_cache_create_30m_usd, cost_cache_create_1h_usd,
          cost_cache_read_usd, cost_output_usd,
          visible_input_chars, visible_output_chars, visible_total_chars, visible_chars_per_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertOutputCharMetric: db.prepare(`
        INSERT INTO output_char_metrics(
          source_path, turn_id, timestamp, date_key, week_key, month_key, year_key,
          provider, model, project, effort,
          visible_output_chars, visible_output_tokens, output_chars_per_token
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertRateLimit: db.prepare(`
        INSERT INTO rate_limit_samples(
          source_path, line_no, sample_key, group_key, sequence, timestamp_ms,
          limit_id, limit_name, plan_type, kind, window_minutes,
          used_percent, resets_at, reached, agent, effort, model,
          input, cache_read, output, reasoning_output, priced, cost_usd, reasoning_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    };
  }

  function insertSourceRow(statement, source, fingerprint) {
    statement.run(
      source.path,
      source.kind,
      source.archivePath || null,
      source.entryName || null,
      fingerprint,
      source.sizeBytes ?? null,
      source.compressedSizeBytes ?? null,
      new Date().toISOString(),
    );
  }

  function insertSessionRow(statement, session) {
    statement.run(
      session.path,
      session.kind,
      session.archivePath || null,
      session.entryName || null,
      session.sizeBytes ?? null,
      session.compressedSizeBytes ?? null,
      session.startedAt || null,
      session.finishedAt || null,
      number(session.durationMs),
      number(session.lines),
      number(session.records),
      number(session.parseErrors),
      number(session.tokenCountSnapshots),
      number(session.skippedTokenCountSnapshots),
      JSON.stringify(session.stats),
    );
  }

  function insertUsageEventRow(statement, event, defaultSourcePath) {
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
    statement.run(
      event.sourcePath || defaultSourcePath,
      event.lineNo,
      event.timestamp,
      dateKey(timestamp),
      weekKey(timestamp),
      monthKey(timestamp),
      yearKey(timestamp),
      event.provider,
      event.model,
      event.project,
      event.effort,
      event.usage.input,
      event.usage.cacheCreate5m,
      event.usage.cacheCreate30m,
      event.usage.cacheCreate1h,
      event.usage.cacheRead,
      event.usage.output,
      event.usage.reasoningOutput,
      event.usage.contextWindow,
      event.cost.known ? 1 : 0,
      number(event.cost.amount),
      number(event.cost.reasoningAmount),
      number(event.cost.breakdown.input),
      number(event.cost.breakdown.cacheCreate5m),
      number(event.cost.breakdown.cacheCreate30m),
      number(event.cost.breakdown.cacheCreate1h),
      number(event.cost.breakdown.cacheRead),
      number(event.cost.breakdown.output),
      number(event.visibleChars?.input),
      number(event.visibleChars?.output),
      number(event.visibleChars?.total),
      number(event.visibleChars?.charsPerToken),
    );
  }

  function insertOutputCharMetricRow(statement, event, defaultSourcePath) {
    const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
    statement.run(
      event.sourcePath || defaultSourcePath,
      event.turnId || null,
      event.timestamp,
      dateKey(timestamp),
      weekKey(timestamp),
      monthKey(timestamp),
      yearKey(timestamp),
      event.provider,
      event.model,
      event.project,
      event.effort,
      number(event.visibleOutputChars),
      number(event.visibleOutputTokens),
      number(event.charsPerToken),
    );
  }

  function insertRateLimitSampleRow(statement, sample, defaultSourcePath) {
    statement.run(
      sample.sourcePath || defaultSourcePath,
      sample.lineNo,
      sample.key,
      sample.groupKey,
      sample.sequence,
      sample.timestampMs,
      sample.windowMeta.limitId,
      sample.windowMeta.limitName,
      sample.windowMeta.planType,
      sample.windowMeta.kind,
      sample.windowMeta.windowMinutes,
      sample.usedPercent,
      sample.resetsAt,
      sample.reached ? 1 : 0,
      sample.agent,
      sample.effort,
      sample.model,
      sample.usage.input,
      sample.usage.cacheRead,
      sample.usage.output,
      sample.usage.reasoningOutput,
      sample.cost.known ? 1 : 0,
      sample.cost.amount,
      sample.cost.reasoningAmount,
    );
  }

  function headersForSource(headers, sourcePath) {
    return (headers || []).filter((header) => header?.source?.sourcePath === sourcePath);
  }

  async function processAndStoreSource(db, source, fingerprint, options, sourceHeaders) {
    const statements = prepareSourceStatements(db);
    return withAsyncTransaction(db, async () => {
      deleteSourceRows(db, source.path);
      insertSourceRow(statements.insertSource, source, fingerprint);

      const report = newReport();
      report._usageEventSink = (event) => insertUsageEventRow(statements.insertUsage, event, source.path);
      report._outputCharMetricSink = (event) => insertOutputCharMetricRow(statements.insertOutputCharMetric, event, source.path);
      report._rateLimitSampleSink = (sample) => insertRateLimitSampleRow(statements.insertRateLimit, sample, source.path);

      if (source.kind === "jsonl") {
        await processJsonlFile(source.path, report, options);
      } else if (source.kind === "zip-entry") {
        await processZipEntry(source.archivePath, source.entry, report, options);
      } else {
        throw new Error("Unsupported database source kind: " + source.kind);
      }

      for (const session of report.sessions) {
        insertSessionRow(statements.insertSession, session);
      }
      storeSqliteCodexSessionHeaders(db, sourceHeaders);
      return report;
    });
  }

  async function syncJsonlSource(db, input, options, currentHeaders) {
    const stat = input.stat || await fsp.stat(input.path);
    const fingerprint = sourceFingerprint({
      kind: "jsonl",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    if (existingSourceFingerprint(db, input.path) === fingerprint) return false;

    const source = {
      kind: "jsonl",
      path: input.path,
      sizeBytes: stat.size,
    };
    await processAndStoreSource(db, source, fingerprint, options, headersForSource(currentHeaders, source.path));
    return true;
  }

  async function syncZipSource(db, input, options, limiter, currentHeaders) {
    const stat = input.stat || await fsp.stat(input.path);
    const entries = input.entries || (await listZipEntries(input.path))
      .filter((entry) => entry.fileName.endsWith(".jsonl"))
      .sort((a, b) => a.fileName.localeCompare(b.fileName));
    progress(options, "[zip] " + input.path + " size=" + formatSize(stat.size) + " entries=" + formatNumber(entries.length));

    let changed = 0;
    for (const entry of entries) {
      if (!limiter.take()) continue;
      const sourcePath = input.path + ":" + entry.fileName;
      const fingerprint = sourceFingerprint({
        kind: "zip-entry",
        archiveSize: stat.size,
        archiveMtimeMs: stat.mtimeMs,
        entry: entry.fileName,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        localHeaderOffset: entry.localHeaderOffset,
      });
      if (existingSourceFingerprint(db, sourcePath) === fingerprint) continue;

      const source = {
        kind: "zip-entry",
        path: sourcePath,
        archivePath: input.path,
        entryName: entry.fileName,
        sizeBytes: entry.uncompressedSize,
        compressedSizeBytes: entry.compressedSize,
        entry,
      };
      await processAndStoreSource(db, source, fingerprint, options, headersForSource(currentHeaders, source.path));
      changed += 1;
    }
    return changed;
  }

  function ensureSyncDependencies() {
    const required = {
      createLimiter,
      discoverInputs,
      processJsonlFile,
      processZipEntry,
      processingOptionsWithCodexForkRegistry,
    };
    for (const [name, helper] of Object.entries(required)) {
      if (typeof helper !== "function") {
        throw new TypeError("SQLite backend missing ingestion helper: " + name);
      }
    }
  }

  async function syncSqliteDatabase(options) {
    ensureSyncDependencies();
    emitSyncProgress(options, { phase: "discovering" });
    const dbPath = resolveDbPath(options);
    const db = openTokenomicsDatabase(dbPath);
    try {
      const inputs = await discoverInputs(options);
      const { preparedInputs, changedSourcePaths, totalSources } = await prepareStorageInputs(inputs, {
        existingFingerprint: (sourcePath) => existingSourceFingerprint(db, sourcePath),
        sourceFingerprint,
      });
      emitSyncProgress(options, {
        phase: "processing",
        totalSources,
        candidateSources: changedSourcePaths.size,
        completedSources: 0,
      });
      progress(options, "[db] changed source candidates=" + formatNumber(changedSourcePaths.size));
      const persistedCodexSessionHeaders = [
        ...(options.persistedCodexSessionHeaders || []),
        ...loadSqliteCodexSessionHeaders(db),
      ];
      const processingOptions = await processingOptionsWithCodexForkRegistry({
        ...options,
        codexSourcePaths: changedSourcePaths,
        persistedCodexSessionHeaders,
      }, preparedInputs);
      const currentHeaders = processingOptions.codexForkRegistry?.currentHeaders || [];
      const limiter = createLimiter(options.limitFiles);
      let changed = 0;
      for (const input of preparedInputs) {
        if (input.kind === "jsonl") {
          if (!limiter.take()) continue;
          if (await syncJsonlSource(db, input, processingOptions, currentHeaders)) changed += 1;
        } else if (input.kind === "zip") {
          changed += await syncZipSource(db, input, processingOptions, limiter, currentHeaders);
        }
      }
      emitSyncProgress(options, {
        phase: "finalizing",
        totalSources,
        candidateSources: changedSourcePaths.size,
        completedSources: changed,
        changedSources: changed,
      });
      const report = buildReportFromOpenDatabase(db, options);
      progress(options, "[db] " + dbPath + " changed_sources=" + formatNumber(changed) + " sessions=" + formatNumber(report.sessions.length));
      return report;
    } finally {
      db.close();
    }
  }

  function addStoredUsage(report, row) {
    const timestamp = row.timestamp ? new Date(row.timestamp) : new Date(NaN);
    const usage = {
      input: number(row.input),
      cacheCreate5m: number(row.cache_create_5m),
      cacheCreate30m: number(row.cache_create_30m),
      cacheCreate1h: number(row.cache_create_1h),
      cacheRead: number(row.cache_read),
      output: number(row.output),
      reasoningOutput: number(row.reasoning_output),
      contextWindow: number(row.context_window),
    };
    const cost = {
      known: Boolean(row.priced),
      amount: number(row.cost_usd),
      reasoningAmount: number(row.reasoning_cost_usd),
      breakdown: {
        input: number(row.cost_input_usd),
        cacheCreate5m: number(row.cost_cache_create_5m_usd),
        cacheCreate30m: number(row.cost_cache_create_30m_usd),
        cacheCreate1h: number(row.cost_cache_create_1h_usd),
        cacheRead: number(row.cost_cache_read_usd),
        output: number(row.cost_output_usd),
      },
    };
    const visibleChars = normalizeVisibleChars({
      input: row.visible_input_chars,
      output: row.visible_output_chars,
      total: row.visible_total_chars,
      charsPerToken: row.visible_chars_per_token,
    });
    const provider = row.provider || "unknown";
    const model = row.model || UNKNOWN_MODEL;
    const project = row.project || UNKNOWN_PROJECT;
    const effort = normalizeEffort(row.effort);

    addToStats(report.total, usage, cost, visibleChars);
    addToStats(bucket(report.daily, dateKey(timestamp)), usage, cost, visibleChars);
    addToStats(bucket(report.weekly, weekKey(timestamp)), usage, cost, visibleChars);
    addToStats(bucket(report.monthly, monthKey(timestamp)), usage, cost, visibleChars);
    addToStats(bucket(report.yearly, yearKey(timestamp)), usage, cost, visibleChars);
    addToStats(bucket(report.providers, provider), usage, cost, visibleChars);
    addToStats(bucket(report.models, model), usage, cost, visibleChars);
    addToStats(bucket(report.providerModels, provider + "/" + model), usage, cost, visibleChars);
    addToStats(bucket(report.projects, project), usage, cost, visibleChars);
    addToStats(nestedBucket(report.projectDaily, project, dateKey(timestamp)), usage, cost, visibleChars);
    addToStats(nestedBucket(report.projectModels, project, model), usage, cost, visibleChars);
    addToStats(bucket(report.efforts, effort), usage, cost, visibleChars);
    addToStats(nestedBucket(report.modelEfforts, model, effort), usage, cost, visibleChars);

    if (!cost.known) {
      const key = provider + "/" + model;
      report.unpricedModels[key] ??= { provider, model, requests: 0 };
      report.unpricedModels[key].requests += 1;
    }
  }

  function addStoredOutputCharMetric(report, row) {
    addOutputCharTokenMetric(report, {
      sourcePath: row.source_path,
      turnId: row.turn_id,
      timestamp: row.timestamp ? new Date(row.timestamp) : new Date(NaN),
      provider: row.provider || "unknown",
      model: row.model || UNKNOWN_MODEL,
      project: row.project || UNKNOWN_PROJECT,
      effort: normalizeEffort(row.effort),
      visibleOutputChars: number(row.visible_output_chars),
      visibleOutputTokens: number(row.visible_output_tokens),
      charsPerToken: number(row.output_chars_per_token),
    });
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

  function storedRateLimitCurrent(row) {
    return {
      key: row.sample_key,
      groupKey: row.group_key,
      sequence: number(row.sequence),
      timestampMs: number(row.timestamp_ms),
      windowMeta: {
        limitId: row.limit_id,
        limitName: row.limit_name,
        planType: row.plan_type,
        kind: row.kind,
        windowMinutes: row.window_minutes,
      },
      usedPercent: number(row.used_percent),
      resetsAt: number(row.resets_at),
      reached: Boolean(row.reached),
      sourcePath: row.source_path,
      lineNo: row.line_no,
      agent: row.agent,
      effort: normalizeEffort(row.effort),
      model: row.model || UNKNOWN_MODEL,
      usage: {
        input: number(row.input),
        cacheCreate5m: 0,
        cacheCreate1h: 0,
        cacheRead: number(row.cache_read),
        output: number(row.output),
        reasoningOutput: number(row.reasoning_output),
        contextWindow: 0,
      },
      cost: {
        known: Boolean(row.priced),
        amount: number(row.cost_usd),
        reasoningAmount: number(row.reasoning_cost_usd),
      },
    };
  }

  function addStoredRateLimitSample(report, current, previous) {
    const groupKey = current.groupKey || current.key;
    const daily = rateLimitPeriodInfo(current, "daily");
    const weekly = rateLimitPeriodInfo(current, "weekly");
    const buckets = [
      touchRateLimitStats(report.rateLimits.windows, groupKey, current, {
        ...current.windowMeta,
        agent: current.agent,
      }),
      touchRateLimitStats(report.rateLimits.daily, daily.key, current, {
        ...current.windowMeta,
        agent: current.agent,
        periodType: "daily",
        period: daily.period,
      }),
      touchRateLimitStats(report.rateLimits.weekly, weekly.key, current, {
        ...current.windowMeta,
        agent: current.agent,
        periodType: "weekly",
        period: weekly.period,
      }),
    ];

    if (!previous) return;

    if (current.timestampMs < previous.timestampMs) {
      for (const bucket of buckets) bucket.stats.outOfOrder += 1;
      return;
    }

    const sameWindow = current.resetsAt === previous.resetsAt;
    if (sameWindow && current.resetsAt !== 0 && current.usedPercent < previous.usedPercent) {
      for (const bucket of buckets) bucket.stats.ignoredNonMonotonic += 1;
      return;
    }

    const elapsedMs = current.timestampMs - previous.timestampMs;
    if (!sameWindow || current.usedPercent < previous.usedPercent) {
      for (const bucket of buckets) {
        bucket.stats.resets += 1;
      }
      if (elapsedMs > 0) {
        for (const bucket of buckets) {
          bucket.stats.resetGapMs += elapsedMs;
          bucket.stats.maxResetGapMs = Math.max(bucket.stats.maxResetGapMs, elapsedMs);
        }
      }
      return;
    }

    const deltaPercent = current.usedPercent - previous.usedPercent;
    if (deltaPercent > 0) {
      addRateLimitDelta(buckets, deltaPercent, elapsedMs, current);
    }
  }

  function finalizeStoredRateLimits(db, report) {
    report.rateLimits = { windows: {}, daily: {}, weekly: {} };
    let previous = null;
    let previousGroup = null;

    for (const row of db.prepare("SELECT * FROM rate_limit_samples ORDER BY group_key, timestamp_ms, sequence, id").iterate()) {
      const current = storedRateLimitCurrent(row);
      const groupKey = current.groupKey || current.key;
      const sameGroup = groupKey === previousGroup;
      addStoredRateLimitSample(report, current, sameGroup ? previous : null);
      previous = current;
      previousGroup = groupKey;
    }
    report._rateLimitFinalized = true;
  }

  function applyStoredOutputCharQuantiles(db, report) {
    const valid = "output_chars_per_token > 0 AND output_chars_per_token <= " + MAX_VALID_OUTPUT_CHARS_PER_TOKEN;
    const effortRows = db.prepare(`
      WITH ranked AS (
        SELECT
          effort,
          output_chars_per_token AS ratio,
          row_number() OVER (PARTITION BY effort ORDER BY output_chars_per_token) AS rank,
          count(*) OVER (PARTITION BY effort) AS samples
        FROM output_char_metrics
        WHERE ${valid}
      )
      SELECT
        effort,
        min(CASE WHEN rank >= (samples + 9) / 10 THEN ratio END) AS p10,
        min(CASE WHEN rank >= (99 * samples + 99) / 100 THEN ratio END) AS p99
      FROM ranked
      GROUP BY effort
    `).all();
    for (const row of effortRows) {
      const target = bucket(report.efforts, row.effort);
      target.outputCharsPerTokenP10 = number(row.p10);
      target.outputCharsPerTokenP99 = number(row.p99);
    }

    const totalRow = db.prepare(`
      WITH ranked AS (
        SELECT
          output_chars_per_token AS ratio,
          row_number() OVER (ORDER BY output_chars_per_token) AS rank,
          count(*) OVER () AS samples
        FROM output_char_metrics
        WHERE ${valid}
      )
      SELECT
        min(CASE WHEN rank >= (samples + 9) / 10 THEN ratio END) AS p10,
        min(CASE WHEN rank >= (99 * samples + 99) / 100 THEN ratio END) AS p99
      FROM ranked
    `).get();
    report.total.outputCharsPerTokenP10 = number(totalRow?.p10);
    report.total.outputCharsPerTokenP99 = number(totalRow?.p99);
  }

  function buildReportFromOpenDatabase(db, options = {}) {
    const report = newReport();
    for (const row of db.prepare("SELECT * FROM usage_events ORDER BY timestamp, id").iterate()) {
      addStoredUsage(report, row);
    }
    for (const row of db.prepare("SELECT * FROM output_char_metrics ORDER BY timestamp, id").iterate()) {
      addStoredOutputCharMetric(report, row);
    }
    applyStoredOutputCharQuantiles(db, report);

    for (const row of db.prepare("SELECT * FROM sessions ORDER BY source_path").iterate()) {
      report.sessions.push({
        kind: row.kind,
        path: row.source_path,
        archivePath: row.archive_path,
        entryName: row.entry_name,
        sizeBytes: row.size_bytes,
        compressedSizeBytes: row.compressed_size_bytes,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs: number(row.duration_ms),
        lines: number(row.lines),
        records: number(row.records),
        parseErrors: number(row.parse_errors),
        tokenCountSnapshots: number(row.token_count_snapshots),
        skippedTokenCountSnapshots: number(row.skipped_token_count_snapshots),
        stats: parseStoredStats(row.stats_json),
      });
    }

    const zipFiles = new Set();
    for (const row of db.prepare("SELECT kind, archive_path FROM sources").iterate()) {
      if (row.kind === "jsonl") report.sources.files += 1;
      if (row.kind === "zip-entry") {
        report.sources.zipEntries += 1;
        if (row.archive_path) zipFiles.add(row.archive_path);
      }
    }
    report.sources.zipFiles = zipFiles.size;
    report.sources.parseErrors = report.sessions.reduce((sum, session) => sum + number(session.parseErrors), 0);
    report.sources.tokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.tokenCountSnapshots), 0);
    report.sources.skippedTokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.skippedTokenCountSnapshots), 0);

    finalizeStoredRateLimits(db, report);
    return report;
  }

  function buildReportFromDatabase(dbPath, options = {}) {
    const db = openTokenomicsDatabase(resolveDbPath({ ...options, db: dbPath }));
    try {
      return buildReportFromOpenDatabase(db, options);
    } finally {
      db.close();
    }
  }

  return {
    buildReportFromDatabase,
    buildReportFromOpenDatabase,
    openTokenomicsDatabase,
    resolveDbPath,
    syncDatabase: syncSqliteDatabase,
    syncSqliteDatabase,
  };
}

module.exports = {
  createSqliteBackend,
};
