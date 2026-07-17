"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { buildReportFromClickHouse, loadConfiguration, saveConfiguration, syncDatabase } = require("../app");
const {
  ANALYTICS_DERIVATION_VERSION,
} = require("../lib/core/derivation");
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

  function visibleRows(table, generationId = latestGeneration()?.generation_id) {
    const manifest = new Map((activeRows.import_generation_sources || [])
      .filter((row) => row.generation_id === generationId)
      .map((row) => [row.source_path, row.import_id || ""]));
    return (activeRows[table] || []).filter((row) => (
      manifest.get(row.source_path) === (row.import_id || "")
    ));
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

      if (query.includes("FROM import_generations") && query.includes("committed_at_ms")) {
        const generation = latestGeneration();
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(generation ? `${JSON.stringify(generation)}\n` : "");
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

      if (query.includes("FROM pricing_catalog") && query.includes("ORDER BY provider")) {
        const revision = url.searchParams.get("param_revision");
        const rows = (activeRows.pricing_catalog || []).filter((row) => row.revision === revision);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));
        return;
      }

      if (query.includes("FROM import_generation_sources") && query.includes("source.fingerprint")) {
        const generationId = url.searchParams.get("param_generation");
        const rows = visibleRows("sources", generationId).map((row) => ({
          source_path: row.source_path,
          import_id: row.import_id || "",
          fingerprint: row.fingerprint,
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

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      if (query.includes("FROM usage_events") && query.includes("UNION ALL")) {
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
      } else if (query.includes("FROM sources AS source") && query.includes("countIf")) {
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
    assert.ok(mock.requests.some((request) => request.query.includes("SELECT DISTINCT key, value_json")));
    assert.ok(mock.requests.some((request) => request.query.includes("SELECT DISTINCT *") && request.query.includes("FROM pricing_catalog")));
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
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS usage_events"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS codex_sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS import_generations"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sources"));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS codex_sessions")
      && query.includes("ReplacingMergeTree")
      && query.includes("parent_session_id")
    )));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS usage_events")
      && query.includes("CODEC(ZSTD(3))")
      && query.includes("CODEC(Delta, ZSTD(1))")
      && query.includes("CODEC(Gorilla, ZSTD(1))")
    )));
    const alter = queries.find((query) => query.trim().startsWith("ALTER TABLE usage_events"));
    assert.ok(alter, "long ALTER TABLE SQL should be observed from the request body");
    assert.match(alter, /ADD COLUMN IF NOT EXISTS visible_chars_per_token/);
    const usageStatsQuery = queries.find((query) => query.includes("FROM usage_events") && query.includes("UNION ALL"));
    assert.match(usageStatsQuery, /'providerModelEffortDaily' AS bucket/);
    assert.match(usageStatsQuery, /GROUP BY provider, model, effort, date_key/);
    assert.equal(mock.inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), rows);
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
      /^INSERT INTO (usage_events|output_char_metrics|rate_limit_samples|sessions|sources|codex_session_versions|import_generation_sources) FORMAT JSONEachRow$/.test(request.query.trim())
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
  assert.match(usageStatsQuery, /toStartOfInterval\(parseDateTimeBestEffortOrNull\(timestamp\), INTERVAL 15 MINUTE\)/);
  assert.match(usageStatsQuery, /projectQuarterHourlyProviderModels/);
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
