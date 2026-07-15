"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { buildReport, buildReportFromDatabase, loadConfiguration, saveConfiguration, syncDatabase } = require("../app");
const {
  ANALYTICS_DERIVATION_VERSION,
  sourceFingerprint,
} = require("../lib/core/derivation");
const { createSqliteBackend } = require("../lib/storage/sqlite");
const { defaultOptions } = require("./support/fixtures");

function totalSnapshot(report) {
  return Object.fromEntries([
    "requests",
    "input",
    "cacheCreate5m",
    "cacheCreate30m",
    "cacheCreate1h",
    "cacheRead",
    "output",
    "reasoningOutput",
    "costUsd",
    "reasoningCostUsd",
    "pricedRequests",
    "unpricedRequests",
    "visibleInputChars",
    "visibleOutputChars",
    "visibleTotalChars",
    "outputCharTokenSamples",
  ].map((key) => [key, report.total[key]]));
}

test("SQLite backend factory creates an empty database and report", () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-empty-db-test-"));
  const db = Path.join(tmp, "nested", "tokenomics.sqlite");

  const backend = createSqliteBackend();
  assert.equal(typeof backend.buildReportFromDatabase, "function");
  const report = backend.buildReportFromDatabase(db, defaultOptions());

  assert.equal(fs.existsSync(db), true);
  assert.equal(report.total.requests, 0);
  assert.equal(report.sessions.length, 0);
  assert.deepEqual(report.sources, {
    files: 0,
    zipFiles: 0,
    zipEntries: 0,
    parseErrors: 0,
    skippedFiles: 0,
    tokenCountSnapshots: 0,
    skippedTokenCountSnapshots: 0,
  });
});

test("SQLite fork pre-scan excludes unchanged sources", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-sqlite-prescan-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  fs.writeFileSync(jsonl, '{"type":"session_meta","payload":{"id":"019f4973-7053-7623-a798-0e4cf81ef014"}}\n');
  const forkCandidates = [];
  const backend = createSqliteBackend({
    createLimiter: () => ({ take: () => true }),
    discoverInputs: async () => [{ kind: "jsonl", path: jsonl }],
    processJsonlFile: async () => {},
    processZipEntry: async () => {},
    processingOptionsWithCodexForkRegistry: async (options) => {
      forkCandidates.push([...options.codexSourcePaths]);
      return options;
    },
  });
  const options = defaultOptions({ db, progress: false });

  await backend.syncSqliteDatabase(options);
  await backend.syncSqliteDatabase(options);

  assert.deepEqual(forkCandidates, [[jsonl], []]);
});

test("syncDatabase imports sources idempotently and replaces changed sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-db-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");

  const writeSession = (outputTokens) => fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-db", model: "gpt-5-codex", effort: "high" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: outputTokens,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  writeSession(200_000);
  const progressEvents = [];
  const first = await syncDatabase(defaultOptions({
    db,
    paths: [jsonl],
    onSyncProgress: (event) => progressEvents.push(event),
  }));
  const second = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));

  assert.equal(first.total.requests, 1);
  assert.equal(first.quarterHourly["2026-07-05T00:00Z"].requests, 1);
  assert.equal(first.projectQuarterHourly["/tmp/project-db"]["2026-07-05T00:00Z"].requests, 1);
  assert.equal(second.total.requests, 1);
  assert.equal(second.total.output, 200_000);
  assert.equal(second.sessions.length, 1);
  assert.equal(progressEvents[0].phase, "discovering");
  assert.ok(progressEvents.some((event) => event.phase === "processing" && event.currentSource === jsonl));
  assert.ok(progressEvents.some((event) => event.phase === "processing" && event.sourceCompleted));
  assert.deepEqual(progressEvents.at(-1), {
    phase: "finalizing",
    totalSources: 1,
    candidateSources: 1,
    completedSources: 1,
    changedSources: 1,
  });

  writeSession(300_000);
  const updated = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  assert.equal(updated.total.requests, 1);
  assert.equal(updated.total.output, 300_000);
  assert.equal(updated.sessions[0].stats.output, 300_000);

  const stored = new DatabaseSync(db);
  try {
    const usage = stored.prepare("SELECT input, cache_read FROM usage_events").get();
    assert.deepEqual({ ...usage }, { input: 900_000, cache_read: 100_000 });
  } finally {
    stored.close();
  }

  const fromDb = buildReportFromDatabase(db, defaultOptions());
  assert.equal(fromDb.total.requests, 1);
  assert.equal(fromDb.quarterHourly["2026-07-05T00:00Z"].requests, 1);
  assert.equal(fromDb.total.output, 300_000);
});

test("pricing edits reprice SQLite reports immediately without reimporting unchanged sources", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-db-reprice-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-reprice", model: "gpt-5-codex", effort: "high" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 100_000, output_tokens: 100_000 } } },
    }),
    "",
  ].join("\n"));
  const options = defaultOptions({ db, paths: [jsonl] });
  const before = await syncDatabase(options);
  const storedBefore = new DatabaseSync(db);
  const sourceBefore = storedBefore.prepare("SELECT fingerprint, imported_at FROM sources WHERE source_path = ?").get(jsonl);
  storedBefore.close();
  const configuration = await loadConfiguration(options);
  const edited = structuredClone(configuration);
  edited.settings.pricingBasis = "custom";
  edited.prices.find((row) => row.provider === "openai" && row.model === "gpt-5-codex" && row.variant === "short").input *= 2;
  const saved = await saveConfiguration(options, edited);

  const repriced = buildReportFromDatabase(db, options);
  assert.equal(repriced.configurationRevision, saved.revision);
  assert.equal(repriced.pricingStale, false);
  assert.ok(repriced.total.costUsd > before.total.costUsd);

  await syncDatabase(options);
  const storedAfter = new DatabaseSync(db);
  const sourceAfter = storedAfter.prepare("SELECT fingerprint, imported_at FROM sources WHERE source_path = ?").get(jsonl);
  storedAfter.close();
  assert.deepEqual({ ...sourceAfter }, { ...sourceBefore });
});

test("SQLite persists versioned fingerprints and reimports a stale derivation", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-sqlite-derivation-version-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  fs.writeFileSync(jsonl, "{}\n");

  await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const stat = fs.statSync(jsonl);
  const currentFingerprint = sourceFingerprint({
    kind: "jsonl",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
  const stored = new DatabaseSync(db);
  try {
    assert.equal(stored.prepare("SELECT fingerprint FROM sources WHERE source_path = ?").get(jsonl).fingerprint, currentFingerprint);
    assert.match(currentFingerprint, new RegExp(`analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`));
    assert.equal(stored.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1");
    stored.prepare("UPDATE sources SET fingerprint = ? WHERE source_path = ?").run(
      sourceFingerprint({ kind: "jsonl", size: stat.size, mtimeMs: stat.mtimeMs }, {
        analyticsDerivationVersion: ANALYTICS_DERIVATION_VERSION + 1,
      }),
      jsonl,
    );
  } finally {
    stored.close();
  }

  const progressEvents = [];
  await syncDatabase(defaultOptions({
    db,
    paths: [jsonl],
    onSyncProgress: (event) => progressEvents.push(event),
  }));
  assert.equal(progressEvents.at(-1).changedSources, 1);

  const recovered = new DatabaseSync(db);
  try {
    assert.equal(recovered.prepare("SELECT fingerprint FROM sources WHERE source_path = ?").get(jsonl).fingerprint, currentFingerprint);
  } finally {
    recovered.close();
  }
});

test("SQLite replaces a Codex source when archiving moves the same session", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-sqlite-archive-move-"));
  const active = Path.join(tmp, "active.jsonl");
  const archived = Path.join(tmp, "archived.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  const sessionId = "019f5840-0000-7000-8000-000000000001";
  fs.writeFileSync(active, [
    JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/tmp/archive-move" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-07-12T10:00:00.000Z", payload: { cwd: "/tmp/archive-move", model: "gpt-5.4-mini" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-12T10:00:01.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 } } } }),
    "",
  ].join("\n"));

  await syncDatabase(defaultOptions({ db, paths: [active] }));
  fs.renameSync(active, archived);
  const report = await syncDatabase(defaultOptions({ db, paths: [archived] }));

  assert.equal(report.total.requests, 1);
  const stored = new DatabaseSync(db);
  try {
    assert.deepEqual(stored.prepare("SELECT source_path FROM sources ORDER BY source_path").all().map((row) => ({ ...row })), [
      { source_path: archived },
    ]);
    assert.deepEqual({ ...stored.prepare("SELECT source_path FROM codex_sessions WHERE session_id = ?").get(sessionId) }, {
      source_path: archived,
    });
  } finally {
    stored.close();
  }
});

test("syncDatabase reuses persisted Codex parent metadata for a child-only import", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-db-test-"));
  const parent = Path.join(tmp, "parent.jsonl");
  const child = Path.join(tmp, "child.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "81f2c4e4-a0a3-483f-8540-7beb1572ff60";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";

  fs.writeFileSync(parent, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:00:00.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-07-09T20:00:01.000Z", payload: { turn_id: parentTurnId, cwd: "/tmp/parent-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:00:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    "",
  ].join("\n"));
  fs.writeFileSync(child, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:01:00.000Z", payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:00.500Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 }, total_token_usage: { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:01.000Z", payload: { type: "task_started", turn_id: parentTurnId } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:01:03.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:04.000Z", payload: { type: "task_started", turn_id: childTurnId } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-07-09T20:01:05.000Z", payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:06.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 }, total_token_usage: { input_tokens: 150, cached_input_tokens: 135, output_tokens: 15 } } } }),
    "",
  ].join("\n"));

  await syncDatabase(defaultOptions({ db, paths: [parent] }));
  const sqlite = new DatabaseSync(db);
  try {
    const storedParent = sqlite.prepare(`
      SELECT session_id, parent_session_id, source_path, kind
      FROM codex_sessions
      WHERE session_id = ?
    `).get(parentSessionId);
    assert.deepEqual({ ...storedParent }, {
      session_id: parentSessionId,
      parent_session_id: null,
      source_path: parent,
      kind: "jsonl",
    });
  } finally {
    sqlite.close();
  }
  const report = await syncDatabase(defaultOptions({ db, paths: [child] }));

  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 15);
  assert.equal(report.total.cacheRead, 135);
  assert.equal(report.total.output, 15);

  const updatedSqlite = new DatabaseSync(db);
  try {
    const storedChild = updatedSqlite.prepare(`
      SELECT parent_session_id, source_path
      FROM codex_sessions
      WHERE session_id = ?
    `).get(childSessionId);
    assert.deepEqual({ ...storedChild }, {
      parent_session_id: parentSessionId,
      source_path: child,
    });
  } finally {
    updatedSqlite.close();
  }
});

test("strict SQLite source failure rolls back current headers and rows without losing persisted parents", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-header-atomicity-test-"));
  const parent = Path.join(tmp, "parent.jsonl");
  const child = Path.join(tmp, "failed-child.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";

  fs.writeFileSync(parent, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:00:00.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-07-09T20:00:01.000Z", payload: { cwd: "/tmp/parent-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:00:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    "",
  ].join("\n"));

  const writeChild = (withMalformedLine) => fs.writeFileSync(child, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:01:00.000Z", payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:01.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 }, total_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 } } } }),
    ...(withMalformedLine ? ["{ malformed json"] : []),
    "",
  ].join("\n"));

  writeChild(true);
  await syncDatabase(defaultOptions({ db, paths: [parent] }));

  await assert.rejects(
    () => syncDatabase(defaultOptions({ db, paths: [child], strictJson: true })),
    /Invalid JSON in .*failed-child\.jsonl:3/,
  );

  const afterFailure = new DatabaseSync(db);
  try {
    assert.deepEqual(afterFailure.prepare("SELECT session_id, parent_session_id, source_path FROM codex_sessions ORDER BY session_id").all().map((row) => ({ ...row })), [
      { session_id: parentSessionId, parent_session_id: null, source_path: parent },
    ]);
    assert.deepEqual(afterFailure.prepare("SELECT source_path FROM sources ORDER BY source_path").all().map((row) => ({ ...row })), [
      { source_path: parent },
    ]);
    assert.deepEqual(afterFailure.prepare("SELECT source_path FROM sessions ORDER BY source_path").all().map((row) => ({ ...row })), [
      { source_path: parent },
    ]);
    assert.deepEqual(afterFailure.prepare("SELECT source_path FROM usage_events ORDER BY source_path, id").all().map((row) => ({ ...row })), [
      { source_path: parent },
    ]);
  } finally {
    afterFailure.close();
  }

  writeChild(false);
  const recovered = await syncDatabase(defaultOptions({ db, paths: [child], strictJson: true }));
  assert.equal(recovered.total.requests, 2);
  assert.equal(recovered.total.input, 15);
  assert.equal(recovered.total.cacheRead, 135);
  assert.equal(recovered.total.output, 15);

  const afterRecovery = new DatabaseSync(db);
  try {
    assert.deepEqual({ ...afterRecovery.prepare("SELECT parent_session_id, source_path FROM codex_sessions WHERE session_id = ?").get(childSessionId) }, {
      parent_session_id: parentSessionId,
      source_path: child,
    });
  } finally {
    afterRecovery.close();
  }
});

test("SQLite round-trip preserves raw report key totals", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-round-trip-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: {
        turn_id: "019f0000-0000-7000-8000-000000000001",
        cwd: "/tmp/round-trip",
        model: "gpt-5-codex",
        effort: "high",
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-05T00:00:00.500Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "round trip" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000,
            cached_input_tokens: 250,
            output_tokens: 100,
            reasoning_output_tokens: 25,
          },
          model_context_window: 128_000,
        },
        rate_limits: {
          limit_id: "round-trip",
          primary: { used_percent: 10, window_minutes: 300, resets_at: 1_800_000_000 },
        },
      },
    }),
    "",
  ].join("\n"));

  const raw = await buildReport(defaultOptions({ paths: [jsonl] }));
  const stored = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));

  assert.deepEqual(totalSnapshot(stored), totalSnapshot(raw));
  assert.deepEqual(stored.rateLimits, raw.rateLimits);
  assert.deepEqual(Object.keys(stored.models), Object.keys(raw.models));
  assert.deepEqual(Object.keys(stored.projects), Object.keys(raw.projects));
  assert.deepEqual(stored.providerModelEffortDaily, raw.providerModelEffortDaily);
});

test("changed source replacement removes dependent SQLite rows", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-dependent-rows-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");

  const writeSession = (withDependentRows, outputTokens) => fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: {
        turn_id: "019f0000-0000-7000-8000-000000000002",
        cwd: "/tmp/dependent-rows",
        model: "gpt-5-codex",
        effort: "medium",
      },
    }),
    ...(withDependentRows ? [JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-05T00:00:00.500Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "dependent" }] },
    })] : []),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: outputTokens },
          model_context_window: 128_000,
        },
        ...(withDependentRows ? {
          rate_limits: {
            limit_id: "dependent-rows",
            primary: { used_percent: 20, window_minutes: 300, resets_at: 1_800_000_000 },
            secondary: { used_percent: 30, window_minutes: 10080, resets_at: 1_800_400_000 },
          },
        } : {}),
      },
    }),
    "",
  ].join("\n"));

  writeSession(true, 20);
  await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const firstDb = new DatabaseSync(db);
  try {
    assert.equal(firstDb.prepare("SELECT count(*) AS count FROM usage_events").get().count, 1);
    assert.equal(firstDb.prepare("SELECT count(*) AS count FROM output_char_metrics").get().count, 1);
    assert.equal(firstDb.prepare("SELECT count(*) AS count FROM rate_limit_samples").get().count, 2);
  } finally {
    firstDb.close();
  }

  writeSession(false, 30);
  const updated = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const secondDb = new DatabaseSync(db);
  try {
    assert.equal(secondDb.prepare("SELECT count(*) AS count FROM usage_events").get().count, 1);
    assert.equal(secondDb.prepare("SELECT count(*) AS count FROM output_char_metrics").get().count, 0);
    assert.equal(secondDb.prepare("SELECT count(*) AS count FROM rate_limit_samples").get().count, 0);
    assert.equal(secondDb.prepare("SELECT output FROM usage_events").get().output, 30);
  } finally {
    secondDb.close();
  }
  assert.equal(updated.total.output, 30);
  assert.equal(updated.total.requests, 1);
});

test("malformed stored stats_json falls back to empty session stats", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-stats-fallback-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/stats-fallback", model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
      },
    }),
    "",
  ].join("\n"));

  await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const stored = new DatabaseSync(db);
  try {
    stored.prepare("UPDATE sessions SET stats_json = ?").run("not-json");
  } finally {
    stored.close();
  }

  const report = buildReportFromDatabase(db, defaultOptions());
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].stats.requests, 0);
  assert.equal(report.sessions[0].stats.costUsd, 0);
  assert.deepEqual(report.sessions[0].stats.costsUsd, {
    input: 0,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    output: 0,
  });
});
