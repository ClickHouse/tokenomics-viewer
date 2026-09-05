"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { buildReportFromClickHouse, loadConfiguration, saveConfiguration, syncDatabase } = require("../app");
const {
  ANALYTICS_DERIVATION_VERSION,
} = require("../lib/core/derivation");
const { CLAUDE_REQUEST_CHECKPOINT_LIMIT } = require("../lib/ingest/parser");
const { createClickHouseBackend } = require("../lib/storage/clickhouse");
const { defaultOptions } = require("./support/fixtures");

function createSessionFile({ rows, project = "/tmp/project-clickhouse-test", sessionId = "019f4973-7053-7623-a798-0e4cf81ef014", parentSessionId = null }) {
  const filename = Path.join(fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-ch-session-test-")), "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { id: sessionId, ...(parentSessionId ? { forked_from_id: parentSessionId } : {}), cwd: project },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: project, model: "gpt-5.4-mini", effort: "medium" },
    }),
  ];
  for (let i = 0; i < rows; i += 1) {
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
          model_context_window: 128_000,
        },
      },
    }));
  }
  fs.writeFileSync(filename, `${lines.join("\n")}\n`);
  return filename;
}

function createClickHouseServer({ failureStatus = null, failureBody = "", failureAfterInsert = null, failureQueryIncludes = null } = {}) {
  const requests = [];
  const inserts = {};
  const activeRows = {};
  const acceptedInsertCounts = {};
  let injectedFailureTriggered = false;

  function latestGeneration() {
    return [...(activeRows.import_generations || [])].sort((a, b) => (
      Number(b.committed_at_ms) - Number(a.committed_at_ms)
      || String(b.generation_id).localeCompare(String(a.generation_id))
    ))[0] || null;
  }

  function latestConfiguration() {
    return [...(activeRows.configuration_revisions || [])].sort((a, b) => (
      Number(b.committed_at_ms) - Number(a.committed_at_ms)
      || String(b.revision).localeCompare(String(a.revision))
    ))[0] || null;
  }

  function legacySourceRows() {
    const current = new Map();
    for (const row of activeRows.sources || []) {
      if ((row.import_id || "") !== "") continue;
      const previous = current.get(row.source_path);
      if (!previous || Number(row.generation || 0) > Number(previous.generation || 0)) {
        current.set(row.source_path, row);
      }
    }
    return current;
  }

  function latestValidCheckpointRank(generations, targetIndex) {
    const ranks = new Map(generations.slice(0, targetIndex + 1).map((row, index) => [row.generation_id, index]));
    return (activeRows.import_generation_checkpoints || []).reduce((latest, checkpoint) => {
      const rank = ranks.get(checkpoint.generation_id);
      if (rank === undefined) return latest;
      const previous = rank > 0 ? generations[rank - 1] : null;
      const valid = checkpoint.base_generation_id === checkpoint.generation_id || (
        (checkpoint.base_generation_id || "") === (previous?.generation_id || "")
        && Number(checkpoint.base_committed_at_ms || 0) === Number(previous?.committed_at_ms || 0)
      );
      return valid ? Math.max(latest, rank) : latest;
    }, -1);
  }

  function visibleRows(table, generationId = latestGeneration()?.generation_id) {
    const generations = [...(activeRows.import_generations || [])].sort((a, b) => (
      Number(a.committed_at_ms) - Number(b.committed_at_ms)
      || String(a.generation_id).localeCompare(String(b.generation_id))
    ));
    const targetIndex = generations.findIndex((row) => row.generation_id === generationId);
    if (targetIndex < 0) return [];
    const generationRank = new Map(generations.slice(0, targetIndex + 1).map((row, index) => [row.generation_id, index]));
    const checkpointRank = latestValidCheckpointRank(generations, targetIndex);
    const snapshotRank = checkpointRank < 0 ? targetIndex : checkpointRank;
    const manifestHistory = [
      ...(activeRows.import_generation_sources || []).filter((row) => (
        generationRank.get(row.generation_id) === snapshotRank
      )),
      ...(activeRows.import_generation_source_deltas || []).filter((row) => (
        generationRank.has(row.generation_id)
        && generationRank.get(row.generation_id) > checkpointRank
      )),
    ];
    const headRank = new Map();
    for (const row of manifestHistory) {
      const rank = generationRank.get(row.generation_id);
      if (rank >= (headRank.get(row.source_path) ?? -1)) headRank.set(row.source_path, rank);
    }
    const manifest = manifestHistory.filter((row) => (
      !row.deleted && generationRank.get(row.generation_id) === headRank.get(row.source_path)
    ));
    const watermarks = new Map();
    for (const row of manifestHistory) {
      if (row.deleted || row.committed_segment_end === undefined || row.committed_segment_end === null) continue;
      const key = `${row.source_path}\0${row.import_id || ""}`;
      watermarks.set(key, Math.max(watermarks.get(key) ?? 0, Number(row.committed_segment_end)));
    }
    const activeImports = new Map(manifest.map((row) => [
      `${row.source_path}\0${row.import_id || ""}`,
      watermarks.get(`${row.source_path}\0${row.import_id || ""}`) ?? null,
    ]));
    const rows = (activeRows[table] || []).filter((row) => {
      const key = `${row.source_path}\0${row.import_id || ""}`;
      if (!activeImports.has(key)) return false;
      const committedSegmentEnd = activeImports.get(key);
      if (committedSegmentEnd === null) return true;
      const rowSegmentEnd = table === "output_char_metrics"
        ? Number(row.metric_revision || 0)
        : Number(row.segment_end || 0);
      return rowSegmentEnd <= committedSegmentEnd;
    });
    const keyed = new Map();
    for (const row of rows) {
      let key = null;
      if (table === "usage_events") key = `${row.source_path}\0${row.import_id || ""}\0${row.event_key || `line:${row.line_no || 0}`}`;
      else if (table === "output_char_metrics") key = `${row.source_path}\0${row.import_id || ""}\0${row.turn_key || JSON.stringify(row)}`;
      else if (table === "rate_limit_samples") key = `${row.source_path}\0${row.import_id || ""}\0${row.line_no || 0}\0${row.sample_key || ""}\0${row.sequence || 0}`;
      else if (table === "telemetry_events") key = `${row.source_path}\0${row.import_id || ""}\0${row.line_no || 0}\0${row.event_kind || ""}`;
      else if (table === "sessions") key = `${row.source_path}\0${row.import_id || ""}\0${row.segment_start || 0}\0${row.segment_end || 0}`;
      else if (table === "sources") key = `${row.source_path}\0${row.import_id || ""}`;
      if (key === null) return rows;
      const previous = keyed.get(key);
      if (!previous || Number(row.metric_revision || row.segment_end || 0) >= Number(previous.metric_revision || previous.segment_end || 0)) {
        keyed.set(key, row);
      }
    }
    return [...keyed.values()];
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const queryParam = url.searchParams.get("query") || "";
      const bodyText = body.trim();
      const query = queryParam || (bodyText && !bodyText.startsWith("{") ? body : "");
      const requestInfo = {
        body,
        headers: request.headers,
        query,
        queryParam,
        url,
      };
      requests.push(requestInfo);

      const sendFailure = (status, message) => {
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        response.end(message);
      };

      if (failureStatus !== null) {
        sendFailure(failureStatus, failureBody);
        return;
      }
      if (failureQueryIncludes && !injectedFailureTriggered && query.includes(failureQueryIncludes)) {
        injectedFailureTriggered = true;
        sendFailure(503, "injected query failure");
        return;
      }

      const insertMatch = query.trim().match(/^INSERT INTO ([a-z_]+) FORMAT JSONEachRow$/);
      if (insertMatch) {
        const table = insertMatch[1];
        const acceptedBatches = acceptedInsertCounts[table] || 0;
        if (
          failureAfterInsert
          && failureAfterInsert.table === table
          && !injectedFailureTriggered
          && acceptedBatches >= failureAfterInsert.acceptedBatches
        ) {
          injectedFailureTriggered = true;
          sendFailure(failureAfterInsert.status || 503, failureAfterInsert.body || "injected failure");
          return;
        }
        const rows = bodyText ? bodyText.split("\n").map((line) => JSON.parse(line)) : [];
        const insert = {
          bytes: Buffer.byteLength(body),
          body,
          rows: rows.length,
        };
        inserts[table] ??= [];
        inserts[table].push(insert);
        activeRows[table] ??= [];
        activeRows[table].push(...rows);
        acceptedInsertCounts[table] = acceptedBatches + 1;
      }

      const dropMatch = query.trim().match(/^DROP TABLE IF EXISTS ([a-z_]+)$/);
      if (dropMatch) {
        activeRows[dropMatch[1]] = [];
      }

      const deleteMatch = query.trim().match(/^ALTER TABLE ([a-z_]+) DELETE WHERE source_path = \{source:String\}$/);
      if (deleteMatch) {
        const table = deleteMatch[1];
        const sourcePath = url.searchParams.get("param_source");
        activeRows[table] = (activeRows[table] || []).filter((row) => row.source_path !== sourcePath);
      }

      if (query.includes("FROM import_generations") && query.includes("ORDER BY committed_at_ms DESC")) {
        const generation = latestGeneration();
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(generation ? `${JSON.stringify(generation)}\n` : "");
        return;
      }

      if (
        query.includes("SELECT checkpoint.generation_id AS generation_id")
        && query.includes("FROM import_generation_checkpoints AS checkpoint")
      ) {
        const targetGeneration = url.searchParams.get("param_generation");
        const targetCommittedAt = Number(url.searchParams.get("param_committedAt"));
        const checkpoint = [...(activeRows.import_generation_checkpoints || [])]
          .filter((row) => (
            Number(row.committed_at_ms) < targetCommittedAt
            || (
              Number(row.committed_at_ms) === targetCommittedAt
              && String(row.generation_id).localeCompare(targetGeneration) <= 0
            )
          ))
          .sort((a, b) => (
            Number(b.committed_at_ms) - Number(a.committed_at_ms)
            || String(b.generation_id).localeCompare(String(a.generation_id))
          ))[0];
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(checkpoint ? `${JSON.stringify({ generation_id: checkpoint.generation_id })}\n` : "");
        return;
      }

      if (query.includes("AS delta_generations") && query.includes("FROM manifest_deltas")) {
        const targetGeneration = url.searchParams.get("param_generation");
        const generations = [...(activeRows.import_generations || [])].sort((a, b) => (
          Number(a.committed_at_ms) - Number(b.committed_at_ms)
          || String(a.generation_id).localeCompare(String(b.generation_id))
        ));
        const targetRank = generations.findIndex((row) => row.generation_id === targetGeneration);
        const ranks = new Map(generations.slice(0, targetRank + 1).map((row, index) => [row.generation_id, index]));
        const checkpointRank = latestValidCheckpointRank(generations, targetRank);
        const manifestGenerations = new Set((activeRows.import_generation_source_deltas || [])
          .filter((row) => ranks.has(row.generation_id) && ranks.get(row.generation_id) > checkpointRank)
          .map((row) => row.generation_id));
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(`${JSON.stringify({ delta_generations: manifestGenerations.size })}\n`);
        return;
      }

      if (query.includes("FROM configuration_revisions") && query.includes("committed_at_ms")) {
        const revision = latestConfiguration();
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(revision ? `${JSON.stringify(revision)}\n` : "");
        return;
      }

      if (query.includes("FROM analytics_settings") && query.includes("value_json")) {
        const revision = url.searchParams.get("param_revision");
        const rows = (activeRows.analytics_settings || []).filter((row) => row.revision === revision);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      if (query.includes("FROM configuration_metadata") && query.includes("pricing_projection_revision")) {
        const revision = url.searchParams.get("param_revision");
        const rows = (activeRows.configuration_metadata || [])
          .filter((row) => row.revision === revision)
          .sort((a, b) => Number(b.written_at_ms) - Number(a.written_at_ms))
          .slice(0, 1);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      if (query.includes("FROM pricing_catalog") && query.includes("ORDER BY provider")) {
        const revision = url.searchParams.get("param_revision");
        const rows = (activeRows.pricing_catalog || []).filter((row) => row.revision === revision);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      if (query.includes("FROM import_generation_sources") && query.includes("source.fingerprint")) {
        const generationId = url.searchParams.get("param_generation");
        const rowsBySource = new Map();
        const importsBySource = new Map();
        for (const row of visibleRows("sources", generationId)) {
          importsBySource.set(row.source_path, (importsBySource.get(row.source_path) || new Set()).add(row.import_id || ""));
          const previous = rowsBySource.get(row.source_path);
          if (!previous || Number(row.segment_end || 0) >= Number(previous.segment_end || 0)) {
            rowsBySource.set(row.source_path, row);
          }
        }
        const rows = [...rowsBySource.values()].map((row) => ({
          source_path: row.source_path,
          import_id: row.import_id || "",
          fingerprint: row.fingerprint,
          imported_at: row.imported_at || "",
          cursor_version: row.cursor_version || 0,
          segment_start: row.segment_start || 0,
          segment_end: row.segment_end || 0,
          cursor_line: row.cursor_line || 0,
          cursor_guard: row.cursor_guard || "",
          cursor_prefix_guard: row.cursor_prefix_guard || "",
          parser_checkpoint: row.parser_checkpoint || "",
          file_device: row.file_device || "",
          file_inode: row.file_inode || "",
          active_import_count: importsBySource.get(row.source_path)?.size || 0,
        }));
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      if (query.includes("FROM sources") && query.includes("GROUP BY source_path")) {
        const rows = [...legacySourceRows().values()];
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      if (query.includes("FROM codex_session_versions") && query.includes("FROM codex_sessions")) {
        const generationId = url.searchParams.get("param_generation");
        const rowsBySession = new Map();
        for (const row of visibleRows("codex_session_versions", generationId)) {
          rowsBySession.set(row.session_id, row);
        }
        const rows = [...rowsBySession.values()];
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      if (query.includes("FROM committed_sessions") && query.includes("stats_json")) {
        const generationId = url.searchParams.get("param_generation");
        const rows = visibleRows("sessions", generationId);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      if (query.includes("FROM usage_events") && query.includes("GROUP BY GROUPING SETS")) {
        const generationId = url.searchParams.get("param_generation");
        const usageRows = visibleRows("usage_events", generationId).length;
        response.end(`${JSON.stringify({
          bucket: "total",
          key1: "",
          key2: "",
          requests: usageRows,
          input: usageRows,
          cacheCreate5m: 0,
          cacheCreate30m: 0,
          cacheCreate1h: 0,
          cacheRead: 0,
          output: usageRows,
          reasoningOutput: 0,
          costUsd: 0,
          reasoningCostUsd: 0,
          costInputUsd: 0,
          costCacheCreate5mUsd: 0,
          costCacheCreate30mUsd: 0,
          costCacheCreate1hUsd: 0,
          costCacheReadUsd: 0,
          costOutputUsd: 0,
          pricedRequests: usageRows,
          unpricedRequests: 0,
          pricedInput: usageRows,
          pricedCacheCreate5m: 0,
          pricedCacheCreate30m: 0,
          pricedCacheCreate1h: 0,
          pricedCacheRead: 0,
          pricedOutput: usageRows,
          pricedReasoningOutput: 0,
        })}\n`);
      } else if (query.includes("FROM sources AS source") && query.includes("uniqExactIf")) {
        response.end(JSON.stringify({ files: 1, zipEntries: 0, zipFiles: 0 }) + "\n");
      } else {
        response.end("");
      }
    });
  });
  return { acceptedInsertCounts, activeRows, inserts, requests, server, visibleRows };
}

async function withServer(mock, callback) {
  await new Promise((resolve, reject) => mock.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  try {
    return await callback(`http://127.0.0.1:${mock.server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => mock.server.close((error) => error ? reject(error) : resolve()));
  }
}

test("ClickHouse backend exposes an independent factory", () => {
  const backend = createClickHouseBackend();
  assert.equal(typeof backend.buildReportFromClickHouse, "function");
  assert.equal(typeof backend.loadConfiguration, "function");
  assert.equal(typeof backend.saveConfiguration, "function");
  assert.equal(typeof backend.syncClickHouseDatabase, "function");
});

test("ClickHouse configuration revisions publish marker-last and reject stale writers", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_test" });
    const initial = await loadConfiguration(options);
    const edited = structuredClone(initial);
    edited.settings.regionalMultiplier = 1.1;
    edited.settings.monthlyCostLimitUsd = 10_000;
    const saved = await saveConfiguration(options, edited);

    assert.notEqual(saved.revision, initial.revision);
    const reloaded = await loadConfiguration(options);
    assert.equal(reloaded.settings.regionalMultiplier, 1.1);
    assert.equal(reloaded.settings.monthlyCostLimitUsd, 10_000);
    await assert.rejects(saveConfiguration(options, edited), /configuration revision conflict/);
    const settingsInsert = mock.requests.findIndex((request) => request.query.startsWith("INSERT INTO analytics_settings"));
    const pricingInsert = mock.requests.findIndex((request) => request.query.startsWith("INSERT INTO pricing_catalog"));
    const usageOverlay = mock.requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs"));
    const rateLimitOverlay = mock.requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs"));
    const markerInsert = mock.requests.findLastIndex((request) => request.query.startsWith("INSERT INTO configuration_revisions"));
    assert.ok(settingsInsert >= 0 && pricingInsert > settingsInsert);
    assert.ok(usageOverlay > pricingInsert && rateLimitOverlay > usageOverlay && markerInsert > rateLimitOverlay);
    const usageOverlayQuery = mock.requests[usageOverlay].query;
    assert.match(usageOverlayQuery, /parseDateTime64BestEffortOrNull\(toString\(raw\.timestamp\)\)/);
    const rateLimitOverlayQuery = mock.requests[rateLimitOverlay].query;
    assert.doesNotMatch(rateLimitOverlayQuery, /raw\.service_mode/);
    assert.match(rateLimitOverlayQuery, /'unknown' = 'fast'/);
    assert.ok(mock.requests.some((request) => request.query.includes("SELECT DISTINCT key, value_json")));
    assert.ok(mock.requests.some((request) => request.query.includes("SELECT DISTINCT *") && request.query.includes("FROM pricing_catalog")));
  });
});

test("ClickHouse packaged pricing upgrade publishes Opus 5 overlays before the revision marker", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_packaged_upgrade_test" });
    await loadConfiguration(options);

    const legacyRevision = "legacy-packaged-2";
    mock.activeRows.configuration_revisions[0].revision = legacyRevision;
    for (const row of mock.activeRows.analytics_settings) {
      row.revision = legacyRevision;
      if (row.key === "pricingRevision") row.value_json = JSON.stringify("packaged-2");
    }
    mock.activeRows.pricing_catalog = mock.activeRows.pricing_catalog
      .filter((row) => row.model !== "claude-opus-5")
      .map((row) => ({ ...row, revision: legacyRevision }));

    const before = mock.requests.length;
    const upgraded = await loadConfiguration(options);
    const requests = mock.requests.slice(before);

    assert.notEqual(upgraded.revision, legacyRevision);
    assert.match(upgraded.settings.pricingRevision, /^packaged-5:[0-9a-f]{32}$/);
    assert.ok(upgraded.prices.some((row) => row.provider === "anthropic" && row.model === "claude-opus-5"));
    const usageOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs"));
    const rateLimitOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs"));
    const marker = requests.findIndex((request) => request.query.startsWith("INSERT INTO configuration_revisions"));
    assert.ok(usageOverlay >= 0 && rateLimitOverlay > usageOverlay && marker > rateLimitOverlay);

    const stableStart = mock.requests.length;
    const stable = await loadConfiguration(options);
    const repeatedInserts = mock.requests
      .slice(stableStart)
      .filter((request) => request.query.trimStart().startsWith("INSERT INTO"));
    assert.equal(stable.revision, upgraded.revision);
    assert.equal(repeatedInserts.length, 0, "completed packaged upgrade must not replay pricing overlays");
  });
});

test("ClickHouse packaged-3 migration materializes temporal Luna and Terra rows before the revision marker", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_temporal_packaged_upgrade_test" });
    await loadConfiguration(options);

    const legacyRevision = "legacy-packaged-3-temporal";
    mock.activeRows.configuration_revisions[0].revision = legacyRevision;
    for (const row of mock.activeRows.analytics_settings) {
      row.revision = legacyRevision;
      if (row.key === "pricingRevision") row.value_json = JSON.stringify("packaged-3");
    }
    const historicalUntil = "2026-07-29T23:59:59.999Z";
    const currentFrom = "2026-07-30T00:00:00.000Z";
    const temporalModels = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);
    const currentRows = new Map(mock.activeRows.pricing_catalog
      .filter((row) => temporalModels.has(row.model) && row.effective_from === currentFrom)
      .map((row) => [`${row.model}:${row.variant}`, row]));
    mock.activeRows.pricing_catalog = mock.activeRows.pricing_catalog.flatMap((row) => {
      if (row.model === "gpt-6-astra") return [];
      if (row.model === "gpt-5.6-sol") {
        if (row.effective_until !== "2026-08-20T23:59:59.999Z") return [];
        return [{
          ...row,
          revision: legacyRevision,
          row_id: `${row.provider}:${row.model}:${row.variant}`,
          effective_from: "",
          effective_until: "",
          source_url: "https://developers.openai.com/api/docs/pricing",
        }];
      }
      if (!temporalModels.has(row.model)) return [{ ...row, revision: legacyRevision }];
      if (row.effective_until !== historicalUntil) return [];
      const current = currentRows.get(`${row.model}:${row.variant}`);
      return [{
        ...row,
        revision: legacyRevision,
        row_id: `${row.provider}:${row.model}:${row.variant}`,
        effective_from: "",
        effective_until: "",
        input: current.input,
        cache_create_30m: current.cache_create_30m,
        cache_read: current.cache_read,
        output: current.output,
      }];
    });

    const before = mock.requests.length;
    const upgraded = await loadConfiguration(options);
    const requests = mock.requests.slice(before);

    assert.notEqual(upgraded.revision, legacyRevision);
    assert.match(upgraded.settings.pricingRevision, /^packaged-5:[0-9a-f]{32}$/);
    assert.ok(upgraded.prices.some((row) => row.provider === "anthropic" && row.model === "claude-opus-5"));
    assert.ok(upgraded.prices.some((row) => row.provider === "openai" && row.model === "gpt-6-astra"));
    const solRows = upgraded.prices.filter((row) => row.provider === "openai" && row.model === "gpt-5.6-sol");
    assert.equal(solRows.length, 4);
    assert.equal(solRows.filter((row) => row.effectiveUntil === "2026-08-20T23:59:59.999Z").length, 2);
    assert.equal(solRows.filter((row) => row.effectiveFrom === "2026-08-21T00:00:00.000Z").length, 2);
    const temporalRows = upgraded.prices.filter((row) => temporalModels.has(row.model));
    assert.equal(temporalRows.length, 8);
    assert.equal(temporalRows.filter((row) => row.effectiveUntil === historicalUntil).length, 4);
    assert.equal(temporalRows.filter((row) => row.effectiveFrom === currentFrom).length, 4);
    assert.equal(temporalRows.filter((row) => !row.effectiveFrom && !row.effectiveUntil).length, 0);
    assert.equal(temporalRows.find((row) => row.model === "gpt-5.6-luna" && row.variant === "short" && row.effectiveUntil === historicalUntil).input, 1);
    assert.equal(temporalRows.find((row) => row.model === "gpt-5.6-terra" && row.variant === "short" && row.effectiveUntil === historicalUntil).input, 2.5);
    assert.equal(requests.some((request) => request.query.startsWith("INSERT INTO sources")), false);
    const usageOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs"));
    const rateLimitOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs"));
    const marker = requests.findIndex((request) => request.query.startsWith("INSERT INTO configuration_revisions"));
    assert.ok(usageOverlay >= 0 && rateLimitOverlay > usageOverlay && marker > rateLimitOverlay);

    const stableStart = mock.requests.length;
    const stable = await loadConfiguration(options);
    const repeatedInserts = mock.requests
      .slice(stableStart)
      .filter((request) => request.query.trimStart().startsWith("INSERT INTO"));
    assert.equal(stable.revision, upgraded.revision);
    assert.equal(repeatedInserts.length, 0, "completed temporal upgrade must not replay pricing overlays");
  });
});

test("ClickHouse repairs a chained derived packaged migration only for an unchanged legacy catalog", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_chained_packaged_upgrade_test" });
    await loadConfiguration(options);

    const legacyRevision = "81fbbf48-6215-419b-bffb-ddd36a1e96d4";
    const legacyPricingRevision = "packaged-4:fd7377f5073cecef6e9f9b83e190c1c4";
    const historicalUntil = "2026-07-29T23:59:59.999Z";
    const temporalModels = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);
    mock.activeRows.configuration_revisions[0].revision = legacyRevision;
    for (const row of mock.activeRows.analytics_settings) {
      row.revision = legacyRevision;
      if (row.key === "pricingRevision") row.value_json = JSON.stringify(legacyPricingRevision);
    }
    mock.activeRows.pricing_catalog = mock.activeRows.pricing_catalog.flatMap((row) => {
      if (row.model === "gpt-6-astra") return [];
      if (row.model === "gpt-5.6-sol") {
        if (row.effective_until !== "2026-08-20T23:59:59.999Z") return [];
        return [{
          ...row,
          revision: legacyRevision,
          row_id: `${row.provider}:${row.model}:${row.variant}`,
          effective_from: "",
          effective_until: "",
          source_url: "https://developers.openai.com/api/docs/pricing",
        }];
      }
      if (!temporalModels.has(row.model)) {
        return [{
          ...row,
          revision: legacyRevision,
          input: row.input === 0.6 ? 0.6000000000000001 : row.input,
          cache_read: row.cache_read === 0.3
            ? 0.30000000000000004
            : row.cache_read === 0.175 ? 0.17500000000000004 : row.cache_read,
        }];
      }
      if (row.effective_until !== historicalUntil) return [];
      return [{
        ...row,
        revision: legacyRevision,
        row_id: `${row.provider}:${row.model}:${row.variant}`,
        effective_from: "",
        effective_until: "",
      }];
    });

    const before = mock.requests.length;
    const upgraded = await loadConfiguration(options);
    const requests = mock.requests.slice(before);
    const temporalRows = upgraded.prices.filter((row) => temporalModels.has(row.model));

    assert.notEqual(upgraded.revision, legacyRevision);
    assert.equal(temporalRows.length, 8);
    assert.equal(temporalRows.filter((row) => row.effectiveUntil === historicalUntil).length, 4);
    assert.equal(temporalRows.filter((row) => row.effectiveFrom === "2026-07-30T00:00:00.000Z").length, 4);
    assert.equal(temporalRows.filter((row) => !row.effectiveFrom && !row.effectiveUntil).length, 0);
    assert.equal(requests.some((request) => request.query.startsWith("INSERT INTO sources")), false);
    assert.ok(requests.some((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs")));
    assert.ok(requests.some((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs")));
    assert.match(upgraded.settings.pricingRevision, /^packaged-5:[0-9a-f]{32}$/);

    const stableStart = mock.requests.length;
    assert.equal((await loadConfiguration(options)).revision, upgraded.revision);
    assert.equal(mock.requests.slice(stableStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);

    const futureMetadata = mock.activeRows.configuration_metadata.find((row) => row.revision === upgraded.revision);
    futureMetadata.pricing_projection_revision = "3";
    const futureProjectionStart = mock.requests.length;
    await assert.rejects(loadConfiguration(options), /projection revision 3 is newer than 2/);
    assert.equal(mock.requests.slice(futureProjectionStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);

    futureMetadata.pricing_projection_revision = "2";
    futureMetadata.packaged_revision = "packaged-6";
    const futurePackageStart = mock.requests.length;
    await assert.rejects(loadConfiguration(options), /packaged pricing revision packaged-6 is newer than packaged-5/);
    assert.equal(mock.requests.slice(futurePackageStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);

    mock.activeRows.configuration_metadata = mock.activeRows.configuration_metadata
      .filter((row) => row.revision !== upgraded.revision);
    mock.activeRows.analytics_settings.find((row) => (
      row.revision === upgraded.revision && row.key === "pricingRevision"
    )).value_json = JSON.stringify(`packaged-6:${"e".repeat(32)}`);
    const futurePublicStart = mock.requests.length;
    await assert.rejects(loadConfiguration(options), /stored packaged pricing revision packaged-6:.* is newer than packaged-5/);
    assert.equal(mock.requests.slice(futurePublicStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);
  });
});

test("ClickHouse rebuilds managed overlays when projection metadata is stale", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_managed_overlay_rebuild_test" });
    await loadConfiguration(options);

    const legacyRevision = "legacy-managed-packaged-4";
    const legacyPricingRevision = `packaged-4:managed:${"c".repeat(32)}`;
    mock.activeRows.configuration_revisions[0].revision = legacyRevision;
    for (const row of mock.activeRows.analytics_settings) {
      row.revision = legacyRevision;
      if (row.key === "pricingRevision") row.value_json = JSON.stringify(legacyPricingRevision);
    }
    for (const row of mock.activeRows.configuration_metadata) {
      row.revision = legacyRevision;
      row.managed_pricing = 1;
      row.packaged_revision = "packaged-4";
      row.pricing_projection_revision = "stale";
    }
    mock.activeRows.pricing_catalog = mock.activeRows.pricing_catalog
      .map((row) => ({ ...row, revision: legacyRevision }));

    const before = mock.requests.length;
    const upgraded = await loadConfiguration(options);
    const requests = mock.requests.slice(before);

    assert.notEqual(upgraded.revision, legacyRevision);
    assert.match(upgraded.settings.pricingRevision, /^packaged-5:[0-9a-f]{32}$/);
    assert.equal(requests.some((request) => request.query.startsWith("INSERT INTO sources")), false);
    const usageOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs"));
    const rateLimitOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs"));
    const marker = requests.findIndex((request) => request.query.startsWith("INSERT INTO configuration_revisions"));
    assert.ok(usageOverlay >= 0 && rateLimitOverlay > usageOverlay && marker > rateLimitOverlay);
    assert.match(requests[usageOverlay].query, /parseDateTime64BestEffortOrNull\(toString\(raw\.timestamp\)\)/);

    const stableStart = mock.requests.length;
    assert.equal((await loadConfiguration(options)).revision, upgraded.revision);
    assert.equal(mock.requests.slice(stableStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);
  });
});

test("ClickHouse restores managed provenance after an old profile-only writer", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_old_profile_writer_test" });
    await loadConfiguration(options);

    const legacyRevision = "old-compatible-profile-write";
    const legacyPricingRevision = `packaged-4:${"d".repeat(32)}`;
    mock.activeRows.configuration_revisions[0].revision = legacyRevision;
    for (const row of mock.activeRows.analytics_settings) {
      row.revision = legacyRevision;
      if (row.key === "pricingRevision") row.value_json = JSON.stringify(legacyPricingRevision);
      if (row.key === "monthlyCostLimitUsd") row.value_json = JSON.stringify(321);
    }
    mock.activeRows.configuration_metadata = [];
    mock.activeRows.pricing_catalog = mock.activeRows.pricing_catalog
      .map((row) => ({ ...row, revision: legacyRevision }));

    const before = mock.requests.length;
    const upgraded = await loadConfiguration(options);
    const requests = mock.requests.slice(before);

    assert.notEqual(upgraded.revision, legacyRevision);
    assert.match(upgraded.settings.pricingRevision, /^packaged-5:[0-9a-f]{32}$/);
    assert.equal(upgraded.settings.monthlyCostLimitUsd, 321);
    assert.equal(requests.some((request) => request.query.startsWith("INSERT INTO sources")), false);
    const usageOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs"));
    const marker = requests.findIndex((request) => request.query.startsWith("INSERT INTO configuration_revisions"));
    assert.ok(usageOverlay >= 0 && marker > usageOverlay);
    assert.match(requests[usageOverlay].query, /parseDateTime64BestEffortOrNull\(toString\(raw\.timestamp\)\)/);
    assert.ok(mock.activeRows.configuration_metadata.some((row) => (
      row.revision === upgraded.revision && row.managed_pricing === 1 &&
      row.packaged_revision === "packaged-5" && row.pricing_projection_revision === "2"
    )));

    const stableStart = mock.requests.length;
    assert.equal((await loadConfiguration(options)).revision, upgraded.revision);
    assert.equal(mock.requests.slice(stableStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);
  });
});

test("ClickHouse projection revisions invalidate custom pricing overlays", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_custom_overlay_rebuild_test" });
    const initial = await loadConfiguration(options);

    const legacyRevision = "legacy-custom-projection";
    const legacyPricingRevision = "custom-temporal-prices";
    for (const row of mock.activeRows.configuration_revisions) row.revision = legacyRevision;
    for (const row of mock.activeRows.analytics_settings) {
      row.revision = legacyRevision;
      if (row.key === "pricingBasis") row.value_json = JSON.stringify("custom");
      if (row.key === "pricingRevision") row.value_json = JSON.stringify(legacyPricingRevision);
    }
    mock.activeRows.configuration_metadata = [];
    mock.activeRows.pricing_catalog = mock.activeRows.pricing_catalog.map((row) => ({
      ...row,
      revision: legacyRevision,
      input: row.model === "gpt-5.6-luna" && row.variant === "short" && row.effective_until
        ? 7
        : row.input,
    }));

    const staleWrite = structuredClone(initial);
    staleWrite.revision = legacyRevision;
    staleWrite.settings.pricingBasis = "custom";
    staleWrite.settings.pricingRevision = legacyPricingRevision;
    staleWrite.settings.monthlyCostLimitUsd = 123;
    staleWrite.prices.find((row) => (
      row.model === "gpt-5.6-luna" && row.variant === "short" && row.effectiveUntil
    )).input = 7;
    const before = mock.requests.length;
    await assert.rejects(saveConfiguration(options, staleWrite), /configuration revision conflict/);
    const upgraded = await loadConfiguration(options);
    const requests = mock.requests.slice(before);
    const historicalLuna = upgraded.prices.find((row) => (
      row.model === "gpt-5.6-luna" && row.variant === "short" && row.effectiveUntil
    ));

    assert.notEqual(upgraded.revision, legacyRevision);
    assert.equal(upgraded.settings.pricingBasis, "custom");
    assert.notEqual(upgraded.settings.pricingRevision, legacyPricingRevision);
    assert.equal(upgraded.settings.monthlyCostLimitUsd, null);
    assert.equal(historicalLuna.input, 7);
    const usageOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs"));
    const rateLimitOverlay = requests.findIndex((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs"));
    const marker = requests.findIndex((request) => request.query.startsWith("INSERT INTO configuration_revisions"));
    assert.ok(usageOverlay >= 0 && rateLimitOverlay > usageOverlay && marker > rateLimitOverlay);
    assert.match(requests[usageOverlay].query, /parseDateTime64BestEffortOrNull\(toString\(raw\.timestamp\)\)/);
    assert.ok(mock.activeRows.configuration_metadata.some((row) => (
      row.revision === upgraded.revision && row.managed_pricing === 0 &&
      row.pricing_projection_revision === "2"
    )));

    const stableStart = mock.requests.length;
    assert.equal((await loadConfiguration(options)).revision, upgraded.revision);
    assert.equal(mock.requests.slice(stableStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);
  });
});

test("ClickHouse preserves edited standard rows while rebasing only older derived overlays", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_edited_derived_packaged_test" });
    await loadConfiguration(options);

    const legacyRevision = "81fbbf48-6215-419b-bffb-ddd36a1e96d4";
    const legacyPricingRevision = "packaged-5:fd7377f5073cecef6e9f9b83e190c1c4";
    const historicalUntil = "2026-07-29T23:59:59.999Z";
    const temporalModels = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);
    mock.activeRows.configuration_revisions[0].revision = legacyRevision;
    for (const row of mock.activeRows.analytics_settings) {
      row.revision = legacyRevision;
      if (row.key === "pricingRevision") row.value_json = JSON.stringify(legacyPricingRevision);
    }
    for (const row of mock.activeRows.configuration_metadata) {
      row.revision = legacyRevision;
      row.managed_pricing = 0;
      row.packaged_revision = "";
      row.pricing_projection_revision = "2";
    }
    mock.activeRows.pricing_catalog = mock.activeRows.pricing_catalog.flatMap((row) => {
      if (!temporalModels.has(row.model)) return [{ ...row, revision: legacyRevision }];
      if (row.effective_until !== historicalUntil) return [];
      return [{
        ...row,
        revision: legacyRevision,
        row_id: `${row.provider}:${row.model}:${row.variant}`,
        effective_from: "",
        effective_until: "",
        input: row.model === "gpt-5.6-luna" && row.variant === "short" ? 99 : row.input,
      }];
    });

    const before = mock.requests.length;
    const preserved = await loadConfiguration(options);
    const requests = mock.requests.slice(before);
    const luna = preserved.prices.find((row) => row.model === "gpt-5.6-luna" && row.variant === "short");

    assert.equal(preserved.revision, legacyRevision);
    assert.equal(preserved.settings.pricingRevision, legacyPricingRevision);
    assert.equal(luna.input, 99);
    assert.equal(preserved.prices.some((row) => row.effectiveFrom === "2026-07-30T00:00:00.000Z"), false);
    assert.equal(requests.some((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs")), false);
    assert.equal(requests.some((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs")), false);
    assert.equal(requests.some((request) => request.query.startsWith("INSERT INTO configuration_revisions")), false);

    const stableStart = mock.requests.length;
    assert.equal((await loadConfiguration(options)).revision, preserved.revision);
    assert.equal(mock.requests.slice(stableStart).some((request) => request.query.trimStart().startsWith("INSERT INTO")), false);

    for (const row of mock.activeRows.analytics_settings) {
      if (row.revision === legacyRevision && row.key === "pricingRevision") {
        row.value_json = JSON.stringify("packaged-3:98676efa611fd1bf680b1262d5515820");
      }
    }
    const rebaseStart = mock.requests.length;
    const rebased = await loadConfiguration(options);
    const rebaseRequests = mock.requests.slice(rebaseStart);
    const rebasedLuna = rebased.prices.find((row) => row.model === "gpt-5.6-luna" && row.variant === "short");

    assert.notEqual(rebased.revision, legacyRevision);
    assert.match(rebased.settings.pricingRevision, /^packaged-5:[0-9a-f]{32}$/);
    assert.equal(rebasedLuna.input, 99);
    assert.equal(rebased.prices.some((row) => row.effectiveFrom === "2026-07-30T00:00:00.000Z"), false);
    assert.ok(rebaseRequests.some((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs")));
    assert.ok(rebaseRequests.some((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs")));
    assert.ok(rebaseRequests.some((request) => request.query.startsWith("INSERT INTO configuration_revisions")));
  });
});

test("ClickHouse pricing overlay failure leaves the previous configuration visible", async () => {
  const mock = createClickHouseServer({ failureQueryIncludes: "INSERT INTO rate_limit_sample_costs" });
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_reprice_failure_test" });
    const initial = await loadConfiguration(options);
    const edited = structuredClone(initial);
    edited.settings.regionalMultiplier = 1.1;

    await assert.rejects(saveConfiguration(options, edited), /injected query failure/);
    assert.equal((await loadConfiguration(options)).revision, initial.revision);
    assert.equal(mock.activeRows.configuration_revisions.length, 1);
  });
});

test("ClickHouse profile-only configuration changes reuse pricing overlays", async () => {
  const mock = createClickHouseServer();
  await withServer(mock, async (clickhouseUrl) => {
    const options = defaultOptions({ dbEngine: "clickhouse", clickhouseUrl, clickhouseDatabase: "tokenomics_profile_test" });
    const initial = await loadConfiguration(options);
    const edited = structuredClone(initial);
    edited.settings.usageProfile = { id: "home", name: "Home Subscription", mode: "subscription" };
    const before = mock.requests.length;
    const saved = await saveConfiguration(options, edited);
    const requests = mock.requests.slice(before);

    assert.notEqual(saved.revision, initial.revision);
    assert.equal(saved.settings.pricingRevision, initial.settings.pricingRevision);
    assert.equal(requests.some((request) => request.query.trimStart().startsWith("INSERT INTO usage_event_costs")), false);
    assert.equal(requests.some((request) => request.query.trimStart().startsWith("INSERT INTO rate_limit_sample_costs")), false);
  });
});

test("ClickHouse fork pre-scan excludes unchanged sources", async () => {
  const jsonl = createSessionFile({ rows: 1 });
  const mock = createClickHouseServer();
  const forkCandidates = [];
  const progressEvents = [];
  const backend = createClickHouseBackend({
    createLimiter: () => ({ take: () => true }),
    discoverInputs: async () => [{ kind: "jsonl", path: jsonl }],
    processJsonlFile: async () => {},
    processZipEntry: async () => {},
    processingOptionsWithCodexForkRegistry: async (options) => {
      forkCandidates.push([...options.codexSourcePaths]);
      return options;
    },
  });

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_unchanged_prescan_test",
      progress: false,
      onSyncProgress: (event) => progressEvents.push(event),
    });
    await backend.syncClickHouseDatabase(options);
    await backend.syncClickHouseDatabase(options);
  });

  assert.deepEqual(forkCandidates, [[jsonl], []]);
  assert.deepEqual(progressEvents.slice(0, 3).map((event) => event.phase), ["discovering", "processing", "finalizing"]);
  assert.deepEqual(progressEvents[2], {
    phase: "finalizing",
    totalSources: 1,
    candidateSources: 1,
    completedSources: 1,
    changedSources: 1,
  });
  assert.deepEqual(progressEvents.at(-1), {
    phase: "finalizing",
    totalSources: 1,
    candidateSources: 0,
    completedSources: 0,
    changedSources: 0,
  });
});

test("ClickHouse sync streams usage rows in bounded insert chunks", async () => {
  const rows = 20_050;
  const jsonl = createSessionFile({
    rows,
    project: "/tmp/project-clickhouse-stream",
    parentSessionId: "019f48d9-4ccc-73c2-bf45-a84e4951347e",
  });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_stream_test",
      clickhouseInsertBatchRows: 100_000,
      clickhouseInsertBatchBytes: 64 * 1024,
      clickhouseReset: true,
      paths: [jsonl],
      progress: false,
    }));

    assert.equal(report.total.requests, rows);
    const queries = mock.requests.map((request) => request.query);
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS rate_limit_samples"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS telemetry_events"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS usage_events"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS codex_sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS import_generations"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS import_generation_checkpoints"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS import_generation_source_deltas"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sources"));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS codex_sessions")
      && query.includes("ReplacingMergeTree")
      && query.includes("parent_session_id")
    )));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS usage_events")
      && query.includes("service_tier LowCardinality(String)")
      && query.includes("service_mode LowCardinality(String)")
      && query.includes("agent LowCardinality(String)")
      && query.includes("CODEC(ZSTD(3))")
      && query.includes("CODEC(Delta, ZSTD(1))")
      && query.includes("CODEC(Gorilla, ZSTD(1))")
    )));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS telemetry_events")
      && query.includes("raw_json String CODEC(ZSTD(6))")
    )));
    const alter = queries.find((query) => query.trim().startsWith("ALTER TABLE usage_events"));
    assert.ok(alter, "long ALTER TABLE SQL should be observed from the request body");
    assert.match(alter, /ADD COLUMN IF NOT EXISTS service_tier/);
    assert.match(alter, /ADD COLUMN IF NOT EXISTS service_mode/);
    assert.match(alter, /ADD COLUMN IF NOT EXISTS agent/);
    assert.match(alter, /ADD COLUMN IF NOT EXISTS visible_chars_per_token/);
    const usageStatsQuery = queries.find((query) => query.includes("FROM usage_events") && query.includes("GROUP BY GROUPING SETS"));
    assert.ok(usageStatsQuery);
    assert.match(usageStatsQuery, /'providerModelEffortDaily'/);
    assert.match(usageStatsQuery, /'serviceTiers'/);
    assert.match(usageStatsQuery, /'serviceModes'/);
    assert.match(usageStatsQuery, /'agents'/);
    assert.match(usageStatsQuery, /\(provider, model, effort, date_key\)/);
    assert.equal((usageStatsQuery.match(/FROM usage_events AS raw/g) || []).length, 1);
    assert.doesNotMatch(usageStatsQuery.slice(usageStatsQuery.indexOf("usage_events_with_dimensions AS")), /UNION ALL/);
    assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), rows);
    assert.equal(JSON.parse(mock.inserts.usage_events[0].body.trim().split("\n")[0]).service_tier, "unknown");
    const firstUsageRow = JSON.parse(mock.inserts.usage_events[0].body.trim().split("\n")[0]);
    assert.equal(firstUsageRow.service_mode, "unknown");
    assert.equal(firstUsageRow.agent, "codex");
    assert.equal(mock.inserts.telemetry_events.reduce((sum, insert) => sum + insert.rows, 0), rows);
    assert.match(mock.inserts.telemetry_events[0].body, /token_count/);
    assert.ok(mock.inserts.usage_events.length > 1);
    assert.ok(mock.inserts.usage_events.every((insert) => insert.rows <= 100_000));
    assert.ok(mock.inserts.usage_events.every((insert) => insert.bytes <= 70 * 1024));
    assert.equal(mock.inserts.codex_session_versions.length, 1);
    const storedSession = JSON.parse(mock.inserts.codex_session_versions[0].body.trim());
    assert.equal(storedSession.session_id, "019f4973-7053-7623-a798-0e4cf81ef014");
    assert.equal(storedSession.parent_session_id, "019f48d9-4ccc-73c2-bf45-a84e4951347e");
    assert.equal(storedSession.source_path, jsonl);
    assert.equal(storedSession.kind, "jsonl");
    assert.equal(storedSession.archive_path, "");
    assert.equal(storedSession.entry_name, "");
    assert.ok(Number.isInteger(storedSession.updated_at_ms));
  });
});

test("ClickHouse replaces a Codex source when archiving moves the same session", async () => {
  const sessionId = "019f5840-0000-7000-8000-000000000002";
  const active = createSessionFile({ rows: 2, sessionId });
  const archived = Path.join(Path.dirname(active), "archived-session.jsonl");
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const base = {
      dbEngine: "clickhouse",
      clickhouseDatabase: "tokenomics_archive_move_test",
      clickhouseUrl: url,
      progress: false,
    };
    await syncDatabase(defaultOptions({ ...base, paths: [active] }));
    fs.renameSync(active, archived);
    const report = await syncDatabase(defaultOptions({ ...base, paths: [archived] }));

    assert.equal(report.total.requests, 2);
    assert.deepEqual(mock.visibleRows("sources").map((row) => row.source_path), [archived]);
    assert.equal(mock.visibleRows("usage_events").length, 2);
  });
});

test("ClickHouse usage sink flushes independently on the row limit", async () => {
  const rows = 5;
  const jsonl = createSessionFile({ rows });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_row_limit_test",
      clickhouseInsertBatchRows: 2,
      clickhouseInsertBatchBytes: 1024 * 1024,
      paths: [jsonl],
      progress: false,
    }));
  });

  assert.deepEqual(mock.inserts.usage_events.map((insert) => insert.rows), [2, 2, 1]);
  assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), rows);
});

test("ClickHouse publishes only complete appended JSONL records in one stable source epoch", async () => {
  const jsonl = createSessionFile({ rows: 2 });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_append_segment_test",
      paths: [jsonl],
      progress: false,
    });
    const initial = await syncDatabase(options);
    assert.equal(initial.total.requests, 2);
    assert.equal(mock.visibleRows("sources").length, 1);
    assert.ok(mock.visibleRows("sources")[0].parser_checkpoint);
    const initialGenerationCount = mock.activeRows.import_generations.length;
    const initialOffset = mock.visibleRows("sources")[0].segment_end;

    const appendedRecord = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:02.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 2,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
          model_context_window: 128_000,
        },
      },
    });
    fs.appendFileSync(jsonl, appendedRecord);
    const partial = await syncDatabase(options);
    assert.equal(partial.total.requests, 2);
    assert.equal(mock.activeRows.import_generations.length, initialGenerationCount);

    fs.appendFileSync(jsonl, "\n");
    const appended = await syncDatabase(options);
    assert.equal(appended.total.requests, 3);
    assert.equal(appended.sessions.length, 1);
    assert.equal(appended.sessions[0].lines, 5);
    assert.equal(mock.activeRows.import_generations.length, initialGenerationCount + 1);
    assert.equal(mock.visibleRows("usage_events").length, 3);
    assert.equal(mock.visibleRows("sources").length, 1);
    const segments = mock.activeRows.sources
      .filter((row) => row.source_path === jsonl)
      .sort((a, b) => a.segment_start - b.segment_start);
    assert.equal(segments.length, 2);
    assert.equal(segments[0].import_id, segments[1].import_id);
    assert.equal(segments[1].segment_start, initialOffset);
    assert.equal(segments[1].cursor_line, 5);
    assert.equal(
      mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0),
      3,
      "the append must insert only the new usage row",
    );
  });
});

test("ClickHouse replaces the provisional metric for an open final Codex turn", async () => {
  const jsonl = createSessionFile({ rows: 0 });
  const turnId = "019f4973-7053-7623-a798-0e4cf81ef0aa";
  fs.appendFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: { turn_id: turnId, cwd: "/tmp/open-turn", model: "gpt-5.4-mini", effort: "medium" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:02.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 },
          total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 4 },
        },
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-05T00:00:03.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcdefghij" }] },
    }),
    "",
  ].join("\n"));
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_open_turn_metric_test",
      paths: [jsonl],
      progress: false,
    });
    await syncDatabase(options);
    assert.equal(mock.visibleRows("output_char_metrics").length, 1);
    assert.equal(mock.visibleRows("output_char_metrics")[0].visible_output_tokens, 4);
    assert.ok(JSON.parse(mock.visibleRows("sources")[0].parser_checkpoint).turn);

    fs.appendFileSync(jsonl, `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:04.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 2, cached_input_tokens: 0, output_tokens: 2 },
          total_token_usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 6 },
        },
      },
    })}\n`);
    await syncDatabase(options);

    const logicalMetrics = mock.visibleRows("output_char_metrics");
    assert.equal(logicalMetrics.length, 1);
    assert.equal(logicalMetrics[0].turn_key, `id:${turnId}`);
    assert.equal(logicalMetrics[0].visible_output_chars, 10);
    assert.equal(logicalMetrics[0].visible_output_tokens, 2);
    assert.equal(mock.activeRows.output_char_metrics.length, 2);
  });
});

test("ClickHouse preserves multiple request metrics within one Codex turn", async () => {
  const jsonl = createSessionFile({ rows: 0 });
  const turnId = "019f4973-7053-7623-a798-0e4cf81ef0ab";
  const tokenCount = (timestamp, totalInput, totalOutput) => ({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 },
        total_token_usage: { input_tokens: totalInput, cached_input_tokens: 0, output_tokens: totalOutput },
      },
    },
  });
  fs.appendFileSync(jsonl, `${[
    {
      type: "turn_context",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: { turn_id: turnId, cwd: "/tmp/multi-metric", model: "gpt-5.4-mini", effort: "medium" },
    },
    {
      type: "response_item",
      timestamp: "2026-07-05T00:00:02.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcd" }] },
    },
    tokenCount("2026-07-05T00:00:03.000Z", 1, 2),
    {
      type: "response_item",
      timestamp: "2026-07-05T00:00:04.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcdef" }] },
    },
    tokenCount("2026-07-05T00:00:05.000Z", 2, 4),
  ].map(JSON.stringify).join("\n")}\n`);
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_multi_metric_turn_test",
      paths: [jsonl],
      progress: false,
    }));
    const metrics = mock.visibleRows("output_char_metrics");
    assert.equal(metrics.length, 2);
    assert.equal(metrics.reduce((sum, row) => sum + row.visible_output_chars, 0), 10);
    assert.equal(metrics.reduce((sum, row) => sum + row.visible_output_tokens, 0), 4);
    assert.deepEqual(metrics.map((row) => row.turn_key).sort(), [
      `id:${turnId}`,
      `id:${turnId}:request:7`,
    ]);
  });
});

test("ClickHouse append storage stays linear beyond the former 128-segment boundary", async () => {
  const changing = createSessionFile({ rows: 1, sessionId: "019f4973-7053-7623-a798-0e4cf81ef0b1" });
  const unchanged = createSessionFile({ rows: 1, sessionId: "019f4973-7053-7623-a798-0e4cf81ef0b2" });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_linear_append_test",
      paths: [changing, unchanged],
      progress: false,
    });
    await syncDatabase(options);
    const epoch = mock.visibleRows("sources").find((row) => row.source_path === changing).import_id;

    for (let index = 0; index < 130; index += 1) {
      fs.appendFileSync(changing, `${JSON.stringify({
        type: "event_msg",
        timestamp: `2026-07-05T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { input_tokens: index + 2, cached_input_tokens: 0, output_tokens: 1 },
            model_context_window: 128_000,
          },
        },
      })}\n`);
      await syncDatabase(options);
    }

    const changingSources = mock.activeRows.sources.filter((row) => row.source_path === changing);
    const unchangedSources = mock.activeRows.sources.filter((row) => row.source_path === unchanged);
    const changingSnapshots = mock.activeRows.import_generation_sources.filter((row) => row.source_path === changing);
    const changingDeltas = mock.activeRows.import_generation_source_deltas.filter((row) => row.source_path === changing);
    const unchangedSnapshots = mock.activeRows.import_generation_sources.filter((row) => row.source_path === unchanged);
    const unchangedDeltas = mock.activeRows.import_generation_source_deltas.filter((row) => row.source_path === unchanged);
    assert.equal(changingSources.length, 131);
    assert.ok(changingSources.every((row) => row.import_id === epoch));
    assert.equal(unchangedSources.length, 1);
    assert.equal(changingSnapshots.length, 2);
    assert.equal(changingDeltas.length, 130);
    assert.equal(unchangedSnapshots.length, 2, "unchanged sources are copied only into bounded metadata checkpoints");
    assert.equal(unchangedDeltas.length, 0);
    assert.equal(mock.activeRows.import_generation_checkpoints.length, 2);
    const checkpointGeneration = mock.activeRows.import_generation_checkpoints.at(-1).generation_id;
    const checkpointIndex = mock.activeRows.import_generations.findIndex((row) => row.generation_id === checkpointGeneration);
    const boundedManifestGenerations = new Set(mock.activeRows.import_generation_source_deltas
      .filter((row) => mock.activeRows.import_generations.findIndex((generation) => generation.generation_id === row.generation_id) > checkpointIndex)
      .map((row) => row.generation_id));
    assert.equal(boundedManifestGenerations.size, 1, "report delta reconstruction must be bounded after a checkpoint");
    const deltaDdl = mock.requests.find((request) => (
      request.query.includes("CREATE TABLE IF NOT EXISTS import_generation_source_deltas")
    ))?.query;
    assert.match(deltaDdl, /ORDER BY \(committed_at_ms, generation_id, source_path\)/);
    const manifestQuery = mock.requests.find((request) => request.query.includes("manifest_deltas AS"))?.query;
    assert.match(manifestQuery, /tuple\(manifest\.committed_at_ms, manifest\.generation_id\) > checkpoint\.boundary/);
    assert.equal(mock.activeRows.usage_events.filter((row) => row.source_path === changing).length, 131);
    assert.equal(mock.visibleRows("usage_events").filter((row) => row.source_path === changing).length, 131);
  });
});

test("ClickHouse Claude append resumes exact request-id deduplication", async () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-ch-claude-append-test-"));
  const jsonl = Path.join(dir, "claude-session.jsonl");
  const claudeRecord = (requestId, timestamp) => JSON.stringify({
    type: "assistant",
    timestamp,
    requestId,
    cwd: "/tmp/claude-append",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
  fs.writeFileSync(jsonl, `${claudeRecord("req-a", "2026-08-15T00:00:00.000Z")}\n`);
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_claude_append_test",
      paths: [jsonl],
      progress: false,
    });
    await syncDatabase(options);
    const firstCheckpoint = JSON.parse(mock.visibleRows("sources")[0].parser_checkpoint);
    assert.equal(firstCheckpoint.kind, "claude");
    assert.deepEqual(firstCheckpoint.recentRequestIds, ["req-a"]);

    fs.appendFileSync(jsonl, [
      claudeRecord("req-a", "2026-08-15T00:00:01.000Z"),
      claudeRecord("req-b", "2026-08-15T00:00:02.000Z"),
      "",
    ].join("\n"));
    const report = await syncDatabase(options);

    assert.equal(report.total.requests, 2);
    assert.equal(mock.visibleRows("usage_events").length, 2);
    assert.equal(mock.visibleRows("sources").length, 1);
    assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), 2);
    const latest = mock.visibleRows("sources").sort((a, b) => a.segment_end - b.segment_end).at(-1);
    assert.deepEqual(JSON.parse(latest.parser_checkpoint).recentRequestIds, ["req-a", "req-b"]);
  });
});

test("ClickHouse Claude append resumes unkeyed usage by global line number", async () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-ch-claude-unkeyed-test-"));
  const jsonl = Path.join(dir, "claude-session.jsonl");
  const claudeRecord = (timestamp) => JSON.stringify({
    type: "assistant",
    timestamp,
    cwd: "/tmp/claude-unkeyed",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
  fs.writeFileSync(jsonl, `${claudeRecord("2026-08-15T00:00:00.000Z")}\n`);
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_claude_unkeyed_test",
      paths: [jsonl],
      progress: false,
    });
    await syncDatabase(options);
    const sourceBefore = mock.visibleRows("sources")[0];
    assert.deepEqual(JSON.parse(sourceBefore.parser_checkpoint).recentRequestIds, []);

    fs.appendFileSync(jsonl, `${claudeRecord("2026-08-15T00:00:01.000Z")}\n`);
    const report = await syncDatabase(options);

    assert.equal(report.total.requests, 2);
    assert.deepEqual(mock.visibleRows("usage_events").map((row) => row.event_key), ["line:1", "line:2"]);
    assert.equal(mock.visibleRows("sources")[0].import_id, sourceBefore.import_id);
  });
});

test("ClickHouse append cursor validates guards when size and mtime are unchanged", async () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-ch-guarded-fingerprint-test-"));
  const jsonl = Path.join(dir, "claude-session.jsonl");
  const claudeRecord = (requestId) => JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-15T00:00:00.000Z",
    requestId,
    cwd: "/tmp/claude-guarded-fingerprint",
    message: {
      model: "claude-opus-4-8",
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
  const initial = `${claudeRecord("req-a")}\n`;
  const replacement = `${claudeRecord("req-b")}\n`;
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(initial));
  fs.writeFileSync(jsonl, initial);
  const originalStat = fs.statSync(jsonl);
  const mock = createClickHouseServer();
  const progressEvents = [];

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_guarded_fingerprint_test",
      paths: [jsonl],
      progress: false,
      onSyncProgress: (event) => progressEvents.push(event),
    });
    await syncDatabase(options);
    const originalImportId = mock.visibleRows("sources")[0].import_id;

    fs.writeFileSync(jsonl, replacement);
    fs.utimesSync(jsonl, originalStat.atimeMs / 1_000, originalStat.mtimeMs / 1_000);
    const replacementStat = fs.statSync(jsonl);
    assert.equal(replacementStat.size, originalStat.size);
    assert.equal(replacementStat.mtimeMs, originalStat.mtimeMs);

    const secondSyncProgress = progressEvents.length;
    const report = await syncDatabase(options);
    assert.equal(report.total.requests, 1);
    assert.equal(mock.visibleRows("usage_events")[0].event_key, "request:req-b");
    assert.notEqual(mock.visibleRows("sources")[0].import_id, originalImportId);
    assert.equal(
      progressEvents.slice(secondSyncProgress).find((event) => event.phase === "processing")?.candidateSources,
      1,
      "the guard mismatch must enter the fork-aware changed-source pre-scan",
    );
  });
});

test("ClickHouse Claude deduplication stays exact after the bounded checkpoint window", async () => {
  const dir = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-ch-claude-bounded-test-"));
  const jsonl = Path.join(dir, "claude-long-session.jsonl");
  const claudeRecord = (requestId, second) => JSON.stringify({
    type: "assistant",
    timestamp: `2026-08-15T00:00:${String(second % 60).padStart(2, "0")}.000Z`,
    requestId,
    cwd: "/tmp/claude-bounded",
    message: { model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const initialCount = CLAUDE_REQUEST_CHECKPOINT_LIMIT + 6;
  fs.writeFileSync(jsonl, `${Array.from({ length: initialCount }, (_, index) => claudeRecord(`req-${index}`, index)).join("\n")}\n`);
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_claude_bounded_test",
      paths: [jsonl],
      progress: false,
    });
    await syncDatabase(options);
    const sourceBefore = mock.visibleRows("sources")[0];
    const checkpoint = JSON.parse(sourceBefore.parser_checkpoint);
    assert.equal(checkpoint.recentRequestIds.length, CLAUDE_REQUEST_CHECKPOINT_LIMIT);
    assert.equal(checkpoint.recentRequestIds.includes("req-0"), false);

    fs.appendFileSync(jsonl, `${claudeRecord("req-0", initialCount)}\n${claudeRecord("req-new", initialCount + 1)}\n`);
    const report = await syncDatabase(options);

    assert.equal(report.total.requests, initialCount + 1);
    assert.equal(mock.visibleRows("usage_events").length, initialCount + 1);
    assert.equal(mock.activeRows.usage_events.length, initialCount + 2);
    assert.equal(mock.visibleRows("sources")[0].import_id, sourceBefore.import_id);
  });
});

test("ClickHouse rewrite replaces the old segment chain with one full import", async () => {
  const jsonl = createSessionFile({ rows: 2 });
  const replacement = createSessionFile({
    rows: 1,
    sessionId: "019f4973-7053-7623-a798-0e4cf81ef099",
  });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_rewrite_segment_test",
      paths: [jsonl],
      progress: false,
    });
    await syncDatabase(options);
    fs.writeFileSync(jsonl, fs.readFileSync(replacement));
    const report = await syncDatabase(options);

    assert.equal(report.total.requests, 1);
    assert.equal(mock.visibleRows("usage_events").length, 1);
    assert.equal(mock.visibleRows("sources").length, 1);
    assert.equal(mock.visibleRows("sources")[0].segment_start, 0);
    assert.equal(mock.activeRows.usage_events.length, 3, "the replaced import remains physically orphaned");
  });
});

test("ClickHouse keeps a legacy multi-import manifest visible until one full epoch migration", async () => {
  const jsonl = createSessionFile({ rows: 2, sessionId: "019f4973-7053-7623-a798-0e4cf81ef0c1" });
  const mock = createClickHouseServer();
  mock.activeRows.import_generations = [{ generation_id: "legacy-segments", committed_at_ms: 1 }];
  mock.activeRows.import_generation_sources = [
    { generation_id: "legacy-segments", source_path: jsonl, import_id: "segment-a", deleted: 0 },
    { generation_id: "legacy-segments", source_path: jsonl, import_id: "segment-b", deleted: 0 },
  ];
  mock.activeRows.sources = [
    { source_path: jsonl, import_id: "segment-a", fingerprint: "old-a", imported_at: "2026-01-01", segment_end: 100 },
    { source_path: jsonl, import_id: "segment-b", fingerprint: "old-b", imported_at: "2026-01-02", segment_end: 200 },
  ];
  mock.activeRows.usage_events = [
    { source_path: jsonl, import_id: "segment-a", event_key: "line:3", line_no: 3 },
    { source_path: jsonl, import_id: "segment-b", event_key: "line:4", line_no: 4 },
  ];

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_legacy_segments_test",
      paths: [jsonl],
      progress: false,
    });
    const legacyReport = await buildReportFromClickHouse(options);
    assert.equal(legacyReport.total.requests, 2);
    assert.equal(mock.visibleRows("sources").length, 2);

    const migrated = await syncDatabase(options);
    assert.equal(migrated.total.requests, 2);
    assert.equal(mock.visibleRows("usage_events").length, 2);
    assert.equal(mock.visibleRows("sources").length, 1);
    assert.equal(mock.activeRows.usage_events.length, 4, "legacy rows stay physically recoverable but become inactive");
  });
});

test("ClickHouse append failure leaves the previous generation visible", async () => {
  const jsonl = createSessionFile({ rows: 1 });
  const mock = createClickHouseServer({
    failureAfterInsert: {
      acceptedBatches: 1,
      body: "injected append failure",
      table: "usage_events",
    },
  });

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_append_failure_test",
      paths: [jsonl],
      progress: false,
    });
    await syncDatabase(options);
    const committedGenerations = mock.activeRows.import_generations.length;
    fs.appendFileSync(jsonl, `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:03.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          model_context_window: 128_000,
        },
      },
    })}\n`);

    await assert.rejects(syncDatabase(options), /injected append failure/);
    assert.equal(mock.activeRows.import_generations.length, committedGenerations);
    assert.equal(mock.visibleRows("usage_events").length, 1);
    assert.equal(mock.visibleRows("sources").length, 1);

    const recovered = await syncDatabase(options);
    assert.equal(recovered.total.requests, 2);
    assert.equal(mock.visibleRows("usage_events").length, 2);
    assert.equal(mock.visibleRows("sources").length, 1);
  });
});

test("ClickHouse commit marker hides staged rows in an already-active source epoch", async () => {
  const jsonl = createSessionFile({ rows: 1 });
  const mock = createClickHouseServer({
    failureAfterInsert: {
      acceptedBatches: 0,
      body: "injected manifest failure",
      table: "import_generation_source_deltas",
    },
  });

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_marker_atomicity_test",
      paths: [jsonl],
      progress: false,
    });
    await syncDatabase(options);
    const committedGenerations = mock.activeRows.import_generations.length;
    const committedOffset = mock.visibleRows("sources")[0].segment_end;
    fs.appendFileSync(jsonl, `${JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:03.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          model_context_window: 128_000,
        },
      },
    })}\n`);

    await assert.rejects(syncDatabase(options), /injected manifest failure/);
    assert.equal(mock.activeRows.import_generations.length, committedGenerations);
    assert.equal(mock.activeRows.usage_events.length, 2, "the delta was physically staged");
    assert.equal(mock.activeRows.sources.length, 2, "the advanced cursor was physically staged");
    assert.equal(mock.visibleRows("usage_events").length, 1, "the old manifest must hide the staged delta");
    assert.equal(mock.visibleRows("sources")[0].segment_end, committedOffset, "the old manifest must pin the old cursor");
    assert.equal((await buildReportFromClickHouse(options)).total.requests, 1);

    const recovered = await syncDatabase(options);
    assert.equal(recovered.total.requests, 2);
    assert.equal(mock.visibleRows("usage_events").length, 2);
    assert.equal(mock.visibleRows("sources").length, 1);
    assert.ok(mock.activeRows.usage_events.length > mock.visibleRows("usage_events").length, "retry duplicates remain physical only");
  });
});

test("ClickHouse rejects a stale concurrent checkpoint and keeps the stable-epoch watermark", async () => {
  const mock = createClickHouseServer();
  const sourcePath = "/tmp/concurrent-stable-epoch.jsonl";
  mock.activeRows.import_generations = [
    { generation_id: "baseline", committed_at_ms: 0 },
    { generation_id: "newer-offset", committed_at_ms: 1 },
    { generation_id: "later-stale-writer", committed_at_ms: 2 },
  ];
  mock.activeRows.import_generation_checkpoints = [
    { generation_id: "baseline", committed_at_ms: 0, base_generation_id: "", base_committed_at_ms: 0 },
    {
      generation_id: "later-stale-writer",
      committed_at_ms: 2,
      base_generation_id: "baseline",
      base_committed_at_ms: 0,
    },
  ];
  mock.activeRows.import_generation_sources = [
    {
      generation_id: "baseline",
      source_path: sourcePath,
      import_id: "stable-epoch",
      committed_segment_end: 0,
      deleted: 0,
    },
    {
      generation_id: "later-stale-writer",
      source_path: sourcePath,
      import_id: "stable-epoch",
      committed_segment_end: 100,
      deleted: 0,
    },
  ];
  mock.activeRows.import_generation_source_deltas = [
    {
      generation_id: "newer-offset",
      source_path: sourcePath,
      import_id: "stable-epoch",
      committed_segment_end: 200,
      deleted: 0,
    },
    {
      generation_id: "later-stale-writer",
      source_path: sourcePath,
      import_id: "stable-epoch",
      committed_segment_end: 100,
      deleted: 0,
    },
  ];
  mock.activeRows.sources = [
    { source_path: sourcePath, import_id: "stable-epoch", segment_end: 100 },
    { source_path: sourcePath, import_id: "stable-epoch", segment_end: 200 },
  ];
  mock.activeRows.usage_events = [
    { source_path: sourcePath, import_id: "stable-epoch", segment_end: 100, event_key: "line:1", line_no: 1 },
    { source_path: sourcePath, import_id: "stable-epoch", segment_end: 200, event_key: "line:2", line_no: 2 },
  ];

  await withServer(mock, async (url) => {
    const report = await buildReportFromClickHouse(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_monotonic_watermark_test",
      progress: false,
    }));
    assert.equal(report.total.requests, 2);
    assert.equal(mock.visibleRows("usage_events").length, 2);
    assert.equal(mock.visibleRows("sources")[0].segment_end, 200);
    assert.ok(mock.requests.some((request) => request.query.includes("manifest_watermarks")));
  });
});

test("ClickHouse session segment aggregation preserves non-numeric metadata", async () => {
  const mock = createClickHouseServer();
  const sourcePath = "/tmp/observed-session-segments.jsonl";
  const observation = {
    agent: "cursor-agent",
    provider: "cursor",
    model: "(unknown model)",
    project: "/tmp/project",
    measurement: "observed-only",
    exactUsageAvailable: false,
  };
  mock.activeRows.import_generations = [{ generation_id: "committed", committed_at_ms: 1 }];
  mock.activeRows.import_generation_sources = [{
    generation_id: "committed",
    source_path: sourcePath,
    import_id: "stable-epoch",
    committed_segment_end: 200,
    deleted: 0,
  }];
  mock.activeRows.sessions = [
    {
      source_path: sourcePath,
      import_id: "stable-epoch",
      segment_start: 0,
      segment_end: 100,
      stats_json: JSON.stringify({ observation }),
    },
    {
      source_path: sourcePath,
      import_id: "stable-epoch",
      segment_start: 100,
      segment_end: 200,
      stats_json: JSON.stringify({ observation }),
    },
  ];

  await withServer(mock, async (url) => {
    const report = await buildReportFromClickHouse(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_session_metadata_test",
      progress: false,
    }));
    assert.equal(report.sessions.length, 1);
    assert.deepEqual(report.sessions[0].stats.observation, observation);
  });
});

test("ClickHouse keeps the whole committed generation visible when a later source fails", async () => {
  const first = createSessionFile({ rows: 2, sessionId: "019f4973-7053-7623-a798-0e4cf81ef014" });
  const second = createSessionFile({ rows: 3, sessionId: "019f4973-7053-7623-a798-0e4cf81ef015" });
  const mock = createClickHouseServer({
    failureAfterInsert: {
      acceptedBatches: 1,
      body: "injected batch failure",
      table: "usage_events",
    },
  });

  mock.activeRows.import_generations = [{ generation_id: "old-generation", committed_at_ms: 1 }];
  mock.activeRows.import_generation_sources = [
    { generation_id: "old-generation", source_path: first, import_id: "old-first" },
    { generation_id: "old-generation", source_path: second, import_id: "old-second" },
  ];
  mock.activeRows.sources = [
    { source_path: first, fingerprint: "old-first-fingerprint", import_id: "old-first" },
    { source_path: second, fingerprint: "old-second-fingerprint", import_id: "old-second" },
  ];
  mock.activeRows.usage_events = [
    { source_path: first, import_id: "old-first" },
    { source_path: second, import_id: "old-second" },
  ];
  mock.activeRows.sessions = [
    { source_path: first, import_id: "old-first" },
    { source_path: second, import_id: "old-second" },
  ];

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseDatabase: "tokenomics_retry_test",
      clickhouseInsertBatchBytes: 1024 * 1024,
      clickhouseInsertBatchRows: 100,
      clickhouseUrl: url,
      paths: [first, second],
      progress: false,
    });

    await assert.rejects(syncDatabase(options), /injected batch failure/);
    assert.equal(mock.acceptedInsertCounts.usage_events, 1);
    assert.ok(mock.activeRows.usage_events.length > mock.visibleRows("usage_events").length);
    assert.equal(mock.activeRows.import_generations.length, 1);
    assert.equal(mock.visibleRows("usage_events").length, 2);

    const reportAfterFailure = await buildReportFromClickHouse(options);
    assert.equal(reportAfterFailure.total.requests, 2);

    const report = await syncDatabase(options);
    assert.equal(report.total.requests, 5);
    assert.equal(mock.visibleRows("usage_events").length, 5);
    assert.equal(mock.visibleRows("sessions").length, 2);
    assert.equal(mock.visibleRows("codex_session_versions").length, 2);
    assert.equal(mock.visibleRows("sources").length, 2);
    assert.equal(mock.activeRows.import_generations.length, 2);
    assert.equal(mock.requests.filter((request) => (
      request.query.trim().startsWith("ALTER TABLE")
      && request.query.includes("DELETE WHERE")
      && [first, second].includes(request.url.searchParams.get("param_source"))
    )).length, 0);

    const markerInsert = mock.requests.findLastIndex((request) => (
      request.query.trim() === "INSERT INTO import_generations FORMAT JSONEachRow"
    ));
    const lastDataInsert = mock.requests.findLastIndex((request) => (
      /^INSERT INTO (usage_events|output_char_metrics|rate_limit_samples|telemetry_events|sessions|sources|codex_session_versions|import_generation_sources|import_generation_source_deltas|import_generation_checkpoints) FORMAT JSONEachRow$/.test(request.query.trim())
    ));
    assert.ok(markerInsert > lastDataInsert, "the global generation marker must be published last");

    const generationsBeforeUnchangedSync = mock.activeRows.import_generations.length;
    await syncDatabase(options);
    assert.equal(mock.visibleRows("usage_events").length, 5);
    assert.equal(mock.activeRows.import_generations.length, generationsBeforeUnchangedSync);
  });
});

test("ClickHouse does not bootstrap staged rows after a failed first sync", async () => {
  const first = createSessionFile({ rows: 1, sessionId: "019f4973-7053-7623-a798-0e4cf81ef021" });
  const second = createSessionFile({ rows: 1, sessionId: "019f4973-7053-7623-a798-0e4cf81ef022" });
  const mock = createClickHouseServer({
    failureAfterInsert: {
      acceptedBatches: 1,
      body: "injected first-sync failure",
      table: "usage_events",
    },
  });

  await withServer(mock, async (url) => {
    const options = defaultOptions({
      dbEngine: "clickhouse",
      clickhouseDatabase: "tokenomics_first_sync_retry_test",
      clickhouseUrl: url,
      paths: [first, second],
      progress: false,
    });

    await assert.rejects(syncDatabase(options), /injected first-sync failure/);
    assert.equal(mock.activeRows.import_generations?.length || 0, 0);
    assert.ok((mock.activeRows.sources?.length || 0) > 0, "the first source should be physically staged");
    assert.equal(mock.visibleRows("usage_events").length, 0);

    const report = await syncDatabase(options);
    assert.equal(report.total.requests, 2);
    assert.equal(mock.activeRows.import_generations.length, 1);
    assert.equal(mock.visibleRows("usage_events").length, 2);
  });
});

test("ClickHouse report pins one committed generation across every query", async () => {
  const mock = createClickHouseServer();
  mock.activeRows.import_generations = [{ generation_id: "pinned-generation", committed_at_ms: 7 }];

  await withServer(mock, async (url) => {
    await buildReportFromClickHouse(defaultOptions({
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_committed_views_test",
    }));
  });

  const reportRequests = mock.requests.filter((request) => (
    request.query.includes("import_generation_sources AS manifest")
  ));
  assert.ok(reportRequests.length >= 7);
  for (const request of reportRequests) {
    assert.equal(request.url.searchParams.get("param_generation"), "pinned-generation");
    assert.doesNotMatch(request.query, /ANY INNER JOIN/);
  }
  const quantileQuery = mock.requests.find((request) => request.query.includes("outputCharsPerTokenP10"))?.query;
  assert.ok(quantileQuery);
  assert.match(quantileQuery, /'total' AS bucket/);
  assert.match(quantileQuery, /'effort' AS bucket/);
  assert.equal((quantileQuery.match(/quantileExactIf\(0\.10\)/g) || []).length, 2);
  assert.equal((quantileQuery.match(/quantileExactIf\(0\.99\)/g) || []).length, 2);
  assert.doesNotMatch(quantileQuery, /quantileTDigestIf/);
  const usageStatsQuery = mock.requests.find((request) => request.query.includes("quarterHourlyProviderModels"))?.query;
  assert.ok(usageStatsQuery);
  assert.match(usageStatsQuery, /GROUP BY GROUPING SETS/);
  assert.doesNotMatch(usageStatsQuery.slice(usageStatsQuery.indexOf("usage_events_with_dimensions AS")), /UNION ALL/);
  const outputCharStatsQuery = mock.requests.find((request) => (
    request.query.includes("visibleOutputTextChars")
  ))?.query;
  assert.ok(outputCharStatsQuery);
  assert.match(outputCharStatsQuery, /GROUP BY GROUPING SETS/);
  assert.match(outputCharStatsQuery, /'projectDaily'/);
  assert.match(outputCharStatsQuery, /'modelEfforts'/);
  assert.match(outputCharStatsQuery, /\(project, date_key\)/);
  assert.match(outputCharStatsQuery, /\(model, effort\)/);
  assert.equal((outputCharStatsQuery.match(/FROM output_char_metrics AS raw/g) || []).length, 1);
  assert.doesNotMatch(outputCharStatsQuery.slice(outputCharStatsQuery.lastIndexOf("SELECT")), /UNION ALL/);
  const rateLimitQueries = mock.requests.filter((request) => request.query.includes("repriced_samples AS"));
  assert.equal(rateLimitQueries.length, 1, "rate-limit windows and attribution should share one window pass");
  const rateLimitQuery = rateLimitQueries[0]?.query;
  assert.ok(rateLimitQuery);
  assert.match(rateLimitQuery, /GROUP BY GROUPING SETS/);
  assert.match(rateLimitQuery, /\(bucket_type, bucket_key, effort\)/);
  assert.match(rateLimitQuery, /\(bucket_type, bucket_key, model, effort\)/);
  assert.match(rateLimitQuery, /AND same_window/);
  assert.match(rateLimitQuery, /argMaxIf\(plan_type[^\n]+isNotNull\(plan_type\)/);
  assert.match(rateLimitQuery, /argMaxIf\(used_percent[^\n]+ignored_non_monotonic = 0\)/);
  assert.match(rateLimitQuery, /maxIf\(timestamp_ms, ignored_non_monotonic = 0\)/);
  const planHistoryQuery = mock.requests.find((request) => request.query.includes("GROUP BY date_key, agent, limit_id, plan_type"))?.query;
  assert.ok(planHistoryQuery);
  assert.doesNotMatch(planHistoryQuery, /any\((agent|limit_id)\)/);
  assert.match(usageStatsQuery, /toStartOfInterval\(parseDateTimeBestEffortOrNull\(timestamp\), INTERVAL 15 MINUTE\)/);
  assert.match(usageStatsQuery, /projectQuarterHourlyProviderModels/);
});

test("ClickHouse manifest query is accepted by the installed clickhouse-local analyzer", async (t) => {
  const mock = createClickHouseServer();
  const home = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-manifest-analyzer-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  mock.activeRows.import_generations = [{ generation_id: "analyzer-generation", committed_at_ms: 7 }];
  mock.activeRows.import_generation_checkpoints = [{
    generation_id: "analyzer-generation",
    committed_at_ms: 7,
    base_generation_id: "analyzer-generation",
    base_committed_at_ms: 7,
  }];
  mock.activeRows.import_generation_sources = [{
    generation_id: "analyzer-generation",
    source_path: "/tmp/analyzer-session.jsonl",
    import_id: "analyzer-import",
    committed_segment_end: 10,
    deleted: 0,
  }];
  mock.activeRows.sources = [{
    source_path: "/tmp/analyzer-session.jsonl",
    import_id: "analyzer-import",
    segment_end: 10,
  }];

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      home,
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_manifest_analyzer_test",
    }));
  });

  const query = mock.requests.find((request) => request.query.includes("uniqExact(source.import_id) AS active_import_count"))?.query;
  assert.ok(query, "generation source query must be captured");
  assert.match(query, /history\.source_path AS source_path/);
  assert.match(query, /history\.import_id AS import_id/);
  assert.match(query, /watermarks\.committed_segment_end AS committed_segment_end/);

  const version = spawnSync("clickhouse", ["local", "--version"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (version.error?.code === "ENOENT") {
    t.diagnostic("clickhouse-local is not installed; SQL shape contract was still checked");
    return;
  }
  assert.ifError(version.error);
  assert.equal(version.status, 0, version.stderr);

  const statements = [
    "CREATE TEMPORARY TABLE import_generations (generation_id String, committed_at_ms UInt64)",
    `CREATE TEMPORARY TABLE import_generation_checkpoints (
      committed_at_ms UInt64,
      generation_id String,
      base_committed_at_ms UInt64,
      base_generation_id String
    )`,
    `CREATE TEMPORARY TABLE import_generation_sources (
      generation_id String,
      source_path String,
      import_id String,
      committed_segment_end Nullable(UInt64),
      deleted UInt8
    )`,
    `CREATE TEMPORARY TABLE import_generation_source_deltas (
      committed_at_ms UInt64,
      generation_id String,
      source_path String,
      import_id String,
      committed_segment_end Nullable(UInt64),
      deleted UInt8
    )`,
    `CREATE TEMPORARY TABLE sources (
      source_path String,
      import_id String,
      fingerprint String,
      imported_at String,
      cursor_version UInt64,
      segment_start UInt64,
      segment_end UInt64,
      cursor_line UInt64,
      cursor_guard String,
      cursor_prefix_guard String,
      parser_checkpoint String,
      file_device String,
      file_inode String
    )`,
    "INSERT INTO import_generations VALUES ('analyzer-generation', 7)",
    "INSERT INTO import_generation_checkpoints VALUES (7, 'analyzer-generation', 7, 'analyzer-generation')",
    "INSERT INTO import_generation_sources VALUES ('analyzer-generation', '/tmp/analyzer-session.jsonl', 'analyzer-import', 10, 0)",
    "INSERT INTO sources VALUES ('/tmp/analyzer-session.jsonl', 'analyzer-import', 'fingerprint', '2026-09-03T00:00:00.000Z', 1, 0, 10, 1, '', '', '', '', '')",
    query,
  ];
  const execution = spawnSync("clickhouse", [
    "local",
    "--param_generation=analyzer-generation",
    ...statements.flatMap((statement) => ["--query", statement]),
  ], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(JSON.parse(execution.stdout.trim()).source_path, "/tmp/analyzer-session.jsonl");
});

test("ClickHouse legacy header union uses explicit migration-safe column order", async () => {
  const mock = createClickHouseServer();
  mock.activeRows.import_generations = [{ generation_id: "headers-generation", committed_at_ms: 9 }];

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseDatabase: "tokenomics_header_union_test",
      clickhouseUrl: url,
      paths: [Path.join(__dirname, "..", "README.md")],
      progress: false,
    }));
  });

  const query = mock.requests.find((request) => (
    request.query.includes("FROM codex_session_versions")
    && request.query.includes("FROM codex_sessions")
  ))?.query;
  assert.ok(query);
  assert.doesNotMatch(query, /SELECT \* FROM codex_/);
  assert.equal((query.match(/session_id, parent_session_id, source_path, import_id/g) || []).length, 2);
});

test("ClickHouse sync imports JSONL entries from ZIP sources", async () => {
  const jsonl = createSessionFile({ rows: 2 });
  const zip = Path.join(Path.dirname(jsonl), "sessions.zip");
  execFileSync("zip", ["-q", zip, Path.basename(jsonl)], { cwd: Path.dirname(jsonl) });
  const mock = createClickHouseServer();
  const removedSource = `${zip}:removed.jsonl`;
  mock.activeRows.import_generations = [{ generation_id: "old-zip-generation", committed_at_ms: 1 }];
  mock.activeRows.import_generation_sources = [{
    generation_id: "old-zip-generation",
    source_path: removedSource,
    import_id: "removed-import",
  }];
  mock.activeRows.sources = [{
    source_path: removedSource,
    import_id: "removed-import",
    fingerprint: "removed-fingerprint",
  }];
  mock.activeRows.usage_events = [{ source_path: removedSource, import_id: "removed-import" }];
  mock.activeRows.sessions = [{ source_path: removedSource, import_id: "removed-import" }];

  await withServer(mock, async (url) => {
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_zip_test",
      paths: [zip],
      progress: false,
    }));
    assert.equal(report.total.requests, 2);
  });

  assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), 2);
  assert.equal(mock.visibleRows("usage_events").length, 2);
  assert.equal(mock.visibleRows("sources").some((row) => row.source_path === removedSource), false);
  const storedSource = mock.visibleRows("sources").find((row) => row.source_path === `${zip}:${Path.basename(jsonl)}`);
  assert.ok(storedSource);
  assert.match(storedSource.fingerprint, new RegExp(`analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`));
  assert.doesNotMatch(storedSource.fingerprint, /pricing(?:CatalogVersion|Revision)=/);
  const storedSession = JSON.parse(mock.inserts.sessions[0].body.trim());
  assert.equal(storedSession.kind, "zip-entry");
  assert.equal(storedSession.archive_path, zip);
  assert.equal(storedSession.entry_name, Path.basename(jsonl));
});

test("ClickHouse usage sink flushes independently on the byte limit", async () => {
  const rows = 4;
  const jsonl = createSessionFile({
    rows,
    project: `/tmp/${"p".repeat(2_048)}`,
  });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_byte_limit_test",
      clickhouseInsertBatchRows: 100_000,
      clickhouseInsertBatchBytes: 1_024,
      paths: [jsonl],
      progress: false,
    }));
  });

  assert.equal(mock.inserts.usage_events.length, rows);
  assert.ok(mock.inserts.usage_events.every((insert) => insert.rows === 1));
  assert.ok(mock.inserts.usage_events.every((insert) => insert.bytes > 1_024));
});

test("ClickHouse bounds metadata, session, and source inserts by rows and bytes", async () => {
  const files = Array.from({ length: 20 }, (_, index) => createSessionFile({
    rows: 1,
    sessionId: `019f4973-7623-73a8-0e4c-${(0x0f81ef014 + index).toString(16).padStart(12, "0")}`,
  }));
  const batchRows = 3;
  const batchBytes = 2_048;
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseDatabase: "tokenomics_metadata_byte_limit_test",
      clickhouseInsertBatchBytes: batchBytes,
      clickhouseInsertBatchRows: batchRows,
      clickhouseUrl: url,
      paths: files,
      progress: false,
    }));
    assert.equal(report.total.requests, files.length);
  });

  for (const table of ["codex_session_versions", "sessions", "sources", "import_generation_sources"]) {
    assert.ok(mock.inserts[table]?.length > 0, `${table} should receive rows`);
    assert.ok(mock.inserts[table].every((insert) => insert.rows <= batchRows));
    assert.ok(mock.inserts[table].every((insert) => insert.rows === 1 || insert.bytes <= batchBytes));
  }
  assert.ok(mock.inserts.codex_session_versions.length > 1, "header inserts should split on the byte limit");
});

test("ClickHouse requests carry database, auth, and bound query parameters", async () => {
  const jsonl = createSessionFile({ rows: 1 });
  const mock = createClickHouseServer();

  await withServer(mock, async (url) => {
    await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_auth_test",
      clickhouseUser: "test-user",
      clickhousePassword: "test-password",
      paths: [jsonl],
      progress: false,
    }));
  });

  assert.ok(mock.requests.length > 0);
  for (const request of mock.requests) {
    if (request.query.trim() !== "CREATE DATABASE IF NOT EXISTS `tokenomics_auth_test`") {
      assert.equal(request.url.searchParams.get("database"), "tokenomics_auth_test");
    }
    assert.equal(request.url.searchParams.get("output_format_json_quote_64bit_integers"), "0");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("test-user:test-password").toString("base64")}`);
  }
  assert.ok(mock.requests.some((request) => request.url.searchParams.get("param_generation")));
});

test("ClickHouse non-2xx responses include the server error", async () => {
  const mock = createClickHouseServer({ failureStatus: 503, failureBody: "backend unavailable" });

  await withServer(mock, async (url) => {
    await assert.rejects(
      buildReportFromClickHouse(defaultOptions({
        clickhouseUrl: url,
        clickhouseDatabase: "tokenomics_error_test",
      })),
      /ClickHouse query failed \(503\): backend unavailable/,
    );
  });
});
