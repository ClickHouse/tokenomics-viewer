"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { newReport, startWebServer, syncDatabase } = require("../app");
const {
  MAX_CONFIGURATION_BODY_BYTES,
  createReportCache,
  createSyncController,
  createWebServer,
  isLoopbackHost,
} = require("../lib/web-server");
const { defaultOptions } = require("./support/fixtures");

test("web server serves stored SQLite summary and sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-web-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-web", model: "gpt-5.4-mini", effort: "medium" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const server = await startWebServer(defaultOptions({ db, host: "127.0.0.1", port: 0 }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const summary = await fetch(`${base}/api/summary`).then((response) => response.json());
    assert.equal(summary.total.requests, 1);
    assert.equal(summary.total.output, 1_000_000);
    assert.equal(summary.topModels[0].name, "gpt-5.4-mini");
    assert.equal(summary.timeline, undefined);

    const timelineJavascript = await fetch(`${base}/timeline.js`);
    assert.equal(timelineJavascript.status, 200);
    assert.match(timelineJavascript.headers.get("content-type"), /text\/javascript/);
    assert.match(await timelineJavascript.text(), /chooseAdaptiveResolution/);

    const timeline = await fetch(`${base}/api/timeline?days=1`).then((response) => response.json());
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].name, "2026-07-05T00:00Z");
    const projectTimeline = await fetch(`${base}/api/timeline?project=${encodeURIComponent("/tmp/project-web")}`).then((response) => response.json());
    assert.equal(projectTimeline.length, 1);
    assert.equal(projectTimeline[0].output, 1_000_000);

    const absoluteTimeline = await fetch(`${base}/api/timeline?from=2026-07-05&to=2026-07-05`).then((response) => response.json());
    assert.equal(absoluteTimeline.length, 1);
    const timestampTimeline = await fetch(`${base}/api/timeline?fromAt=2026-07-05T00%3A00%3A00.000Z&toAt=2026-07-06T00%3A00%3A00.000Z`).then((response) => response.json());
    assert.equal(timestampTimeline.length, 1);
    const reversedRange = await fetch(`${base}/api/timeline?from=2026-07-06&to=2026-07-05`);
    assert.equal(reversedRange.status, 400);
    const mixedRange = await fetch(`${base}/api/timeline?days=1&from=2026-07-05`);
    assert.equal(mixedRange.status, 400);
    const invalidRange = await fetch(`${base}/api/timeline?from=2026-02-30`);
    assert.equal(invalidRange.status, 400);
    const malformedCalendarRange = await fetch(`${base}/api/timeline?from=2026-99-99`);
    assert.equal(malformedCalendarRange.status, 400);
    const incompleteTimestampRange = await fetch(`${base}/api/timeline?fromAt=2026-07-05T00%3A00%3A00.000Z`);
    assert.equal(incompleteTimestampRange.status, 400);

    const sessions = await fetch(`${base}/api/sessions`).then((response) => response.json());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].path, jsonl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("web server reuses preloaded report without rebuilding the database", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-web-cache-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  const missingDb = Path.join(tmp, "missing.sqlite");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-web-cache", model: "gpt-5.4-mini", effort: "medium" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const preloadedReport = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const server = await startWebServer(defaultOptions({
    db: missingDb,
    host: "127.0.0.1",
    port: 0,
    preloadedReport,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const [summary, sessions] = await Promise.all([
      fetch(`${base}/api/summary`).then((response) => response.json()),
      fetch(`${base}/api/sessions`).then((response) => response.json()),
    ]);
    assert.equal(summary.total.requests, 1);
    assert.equal(sessions[0].path, jsonl);
    assert.equal(fs.existsSync(missingDb), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("web server returns 404 for unknown routes and 405 for non-GET requests", async () => {
  const server = await startWebServer(defaultOptions({
    preloadedReport: newReport(),
    host: "127.0.0.1",
    port: 0,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const notFound = await fetch(`${base}/missing`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: "not found" });

    const methodNotAllowed = await fetch(`${base}/api/summary`, { method: "POST" });
    assert.equal(methodNotAllowed.status, 405);
    assert.deepEqual(await methodNotAllowed.json(), { error: "method not allowed" });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("configuration API is readable but loopback and action-header protected for writes", async () => {
  const configuration = {
    revision: "catalog-a",
    settings: { openaiContext: "auto", pricingBasis: "standard", regionalMultiplier: 1 },
    prices: [],
  };
  let saved = null;
  let reportBuilds = 0;
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => {
      reportBuilds += 1;
      return { ...newReport(), configurationRevision: "catalog-b", pricingStale: false };
    },
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-config-api.sqlite"),
    loadConfiguration: async () => configuration,
    saveConfiguration: async (_options, next) => {
      saved = next;
      return { ...next, revision: "catalog-b" };
    },
  });
  const server = await web.startWebServer(defaultOptions({
    preloadedReport: { ...newReport(), configurationRevision: "catalog-a" },
    host: "127.0.0.1",
    port: 0,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const getResponse = await fetch(`${base}/api/configuration`);
    assert.equal(getResponse.status, 200);
    assert.equal((await getResponse.json()).configuration.revision, "catalog-a");

    const rejected = await fetch(`${base}/api/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(configuration),
    });
    assert.equal(rejected.status, 403);
    assert.equal(saved, null);

    const crossSite = await fetch(`${base}/api/configuration`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        "x-tokenomics-action": "configuration",
      },
      body: JSON.stringify(configuration),
    });
    assert.equal(crossSite.status, 403);
    assert.equal(saved, null);

    const oversized = await fetch(`${base}/api/configuration`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-tokenomics-action": "configuration",
      },
      body: JSON.stringify({ padding: "x".repeat(MAX_CONFIGURATION_BODY_BYTES) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(saved, null);

    const accepted = await fetch(`${base}/api/configuration`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-tokenomics-action": "configuration",
      },
      body: JSON.stringify(configuration),
    });
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.configuration.revision, "catalog-b");
    assert.equal(acceptedBody.requiresSync, false);
    assert.equal(saved.revision, "catalog-a");
    assert.equal(reportBuilds, 1);

    const summary = await fetch(`${base}/api/summary`);
    assert.equal((await summary.json()).configurationRevision, "catalog-b");
    assert.equal(reportBuilds, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("sync cannot start while a configuration save is pending", async () => {
  let releaseSave;
  let saveStarted;
  const started = new Promise((resolve) => { saveStarted = resolve; });
  const gate = new Promise((resolve) => { releaseSave = resolve; });
  let syncCalls = 0;
  const configuration = { revision: "catalog-a", settings: {}, prices: [] };
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => ({ ...newReport(), configurationRevision: "catalog-b" }),
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-config-save-lock.sqlite"),
    loadConfiguration: async () => configuration,
    saveConfiguration: async () => {
      saveStarted();
      await gate;
      return { ...configuration, revision: "catalog-b" };
    },
    syncDatabase: async () => {
      syncCalls += 1;
      return newReport();
    },
  });
  const server = await web.startWebServer(defaultOptions({
    preloadedReport: newReport(),
    host: "127.0.0.1",
    port: 0,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const saving = fetch(`${base}/api/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tokenomics-action": "configuration" },
      body: JSON.stringify(configuration),
    });
    await started;
    const blockedSync = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers: { "x-tokenomics-action": "sync" },
    });
    assert.equal(blockedSync.status, 409);
    assert.equal(syncCalls, 0);
    releaseSave();
    assert.equal((await saving).status, 200);
  } finally {
    releaseSave();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("unknown routes do not build the report cache", async () => {
  let buildCalls = 0;
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => {
      buildCalls += 1;
      throw new Error("report builder should not run for unknown routes");
    },
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-unknown-route.sqlite"),
  });
  const server = await web.startWebServer(defaultOptions({ host: "127.0.0.1", port: 0 }));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "not found" });
    assert.equal(buildCalls, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("report cache coalesces concurrent builds and caches the result", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const report = { total: { requests: 3 } };
  const cache = createReportCache(async () => {
    calls += 1;
    await gate;
    return report;
  });

  const first = cache.get();
  const second = cache.get();
  assert.equal(calls, 1);
  release();
  assert.strictEqual(await first, report);
  assert.strictEqual(await second, report);
  assert.strictEqual(await cache.get(), report);
  assert.equal(calls, 1);
});

test("report cache clears failed builds so a later request can retry", async () => {
  let calls = 0;
  const report = { total: { requests: 1 } };
  const cache = createReportCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary report failure");
    return report;
  });

  await assert.rejects(cache.get(), /temporary report failure/);
  assert.strictEqual(await cache.get(), report);
  assert.equal(calls, 2);
});

test("report cache keeps an explicitly replaced report when an older build finishes", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const staleReport = { total: { requests: 1 } };
  const freshReport = { total: { requests: 2 } };
  const cache = createReportCache(async () => {
    await gate;
    return staleReport;
  });

  const pending = cache.get();
  cache.set(freshReport);
  release();

  assert.strictEqual(await pending, freshReport);
  assert.strictEqual(await cache.get(), freshReport);
});

test("sync endpoint requires a same-origin custom action header", async () => {
  let syncCalls = 0;
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => newReport(),
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-protected-sync.sqlite"),
    syncDatabase: async () => {
      syncCalls += 1;
      return newReport();
    },
  });
  const server = await web.startWebServer(defaultOptions({
    preloadedReport: newReport(),
    host: "127.0.0.1",
    port: 0,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const missingHeader = await fetch(`${base}/api/sync`, { method: "POST" });
    assert.equal(missingHeader.status, 403);
    assert.deepEqual(await missingHeader.json(), { error: "sync request rejected" });

    const crossSite = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers: {
        "sec-fetch-site": "cross-site",
        "x-tokenomics-action": "sync",
      },
    });
    assert.equal(crossSite.status, 403);
    assert.deepEqual(await crossSite.json(), { error: "sync request rejected" });
    assert.equal(syncCalls, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("sync endpoint coalesces concurrent runs and atomically publishes the new report", async () => {
  let syncCalls = 0;
  let configurationSaves = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const oldReport = { ...newReport(), marker: "old" };
  const newReportValue = { ...newReport(), marker: "new" };
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => oldReport,
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-coalesced-sync.sqlite"),
    loadConfiguration: async () => ({ revision: "catalog-a", settings: {}, prices: [] }),
    saveConfiguration: async () => {
      configurationSaves += 1;
      return { revision: "catalog-b", settings: {}, prices: [] };
    },
    syncDatabase: async () => {
      syncCalls += 1;
      await gate;
      return newReportValue;
    },
  });
  const server = await web.startWebServer(defaultOptions({
    preloadedReport: oldReport,
    host: "127.0.0.1",
    port: 0,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const requestOptions = {
      method: "POST",
      headers: { "x-tokenomics-action": "sync" },
    };
    const [first, second] = await Promise.all([
      fetch(`${base}/api/sync`, requestOptions).then((response) => response.json()),
      fetch(`${base}/api/sync`, requestOptions).then((response) => response.json()),
    ]);

    assert.equal(syncCalls, 1);
    assert.deepEqual([first.started, second.started].sort(), [false, true]);
    assert.equal(first.sync.runId, second.sync.runId);
    assert.equal(first.sync.state, "running");
    assert.equal(second.sync.state, "running");
    assert.equal((await fetch(`${base}/api/sync`).then((response) => response.json())).sync.state, "running");
    assert.equal((await fetch(`${base}/api/report`).then((response) => response.json())).marker, "old");
    const blockedConfiguration = await fetch(`${base}/api/configuration`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tokenomics-action": "configuration" },
      body: JSON.stringify({ revision: "catalog-a", settings: {}, prices: [] }),
    });
    assert.equal(blockedConfiguration.status, 409);
    assert.equal(configurationSaves, 0);

    release();
    await server.syncController.waitForIdle();

    const completed = await fetch(`${base}/api/sync`).then((response) => response.json());
    assert.equal(completed.sync.state, "succeeded");
    assert.equal(completed.sync.error, null);
    assert.equal((await fetch(`${base}/api/report`).then((response) => response.json())).marker, "new");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("failed sync preserves the cached report and permits a retry", async () => {
  let syncCalls = 0;
  const oldReport = { ...newReport(), marker: "old" };
  const recoveredReport = { ...newReport(), marker: "recovered" };
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => oldReport,
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-retry-sync.sqlite"),
    syncDatabase: async () => {
      syncCalls += 1;
      if (syncCalls === 1) throw new Error("temporary sync failure");
      return recoveredReport;
    },
  });
  const server = await web.startWebServer(defaultOptions({
    preloadedReport: oldReport,
    host: "127.0.0.1",
    port: 0,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const requestOptions = {
      method: "POST",
      headers: { "x-tokenomics-action": "sync" },
    };

    await fetch(`${base}/api/sync`, requestOptions);
    await server.syncController.waitForIdle();
    const failed = await fetch(`${base}/api/sync`).then((response) => response.json());
    assert.equal(failed.sync.state, "failed");
    assert.equal(failed.sync.error, "temporary sync failure");
    assert.equal((await fetch(`${base}/api/report`).then((response) => response.json())).marker, "old");

    const retry = await fetch(`${base}/api/sync`, requestOptions).then((response) => response.json());
    assert.equal(retry.started, true);
    assert.equal(retry.sync.runId, 2);
    await server.syncController.waitForIdle();
    assert.equal((await fetch(`${base}/api/sync`).then((response) => response.json())).sync.state, "succeeded");
    assert.equal((await fetch(`${base}/api/report`).then((response) => response.json())).marker, "recovered");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("loopback host detection rejects wildcard and LAN bindings", () => {
  for (const host of ["127.0.0.1", "127.42.0.9", "::1", "[::1]", "localhost"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.20", "tokenomics.local", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("non-loopback webserver binding exposes status but rejects sync mutations", async () => {
  let syncCalls = 0;
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => newReport(),
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-remote-sync.sqlite"),
    syncDatabase: async () => {
      syncCalls += 1;
      return newReport();
    },
  });
  const server = await web.startWebServer(defaultOptions({
    preloadedReport: newReport(),
    host: "0.0.0.0",
    port: 0,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = await fetch(`${base}/api/sync`).then((response) => response.json());
    assert.equal(status.sync.available, false);
    assert.equal(status.sync.engine, "sqlite");
    assert.match(status.sync.unavailableReason, /loopback host/);

    const response = await fetch(`${base}/api/sync`, {
      method: "POST",
      headers: { "x-tokenomics-action": "sync" },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "sync is disabled for non-loopback webserver bindings" });
    assert.equal(syncCalls, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("sync controller publishes structured progress and a bounded run result", async () => {
  const report = { ...newReport(), sessions: [{}, {}, {}] };
  const cache = createReportCache(async () => newReport(), newReport());
  let clock = 1_000;
  const snapshots = [];
  const controller = createSyncController({
    reportCache: cache,
    options: { dbEngine: "sqlite" },
    now: () => new Date(clock),
    syncDatabase: async (options) => {
      options.onSyncProgress({
        phase: "processing",
        totalSources: 9,
        candidateSources: 3,
        completedSources: 1,
        currentSource: "/tmp/one.jsonl",
      });
      clock = 4_250;
      options.onSyncProgress({
        phase: "finalizing",
        completedSources: 3,
        changedSources: 3,
      });
      return report;
    },
  });
  const unsubscribe = controller.subscribe((status) => snapshots.push(status));
  const unsubscribeBroken = controller.subscribe(() => { throw new Error("observer failed"); });
  assert.equal(controller.listenerCount(), 2);

  assert.equal(controller.start().started, true);
  await controller.waitForIdle();
  unsubscribe();
  unsubscribeBroken();

  const status = controller.getStatus();
  assert.equal(controller.listenerCount(), 0);
  assert.equal(status.state, "succeeded");
  assert.deepEqual(status.progress, {
    phase: "finalizing",
    totalSources: 9,
    candidateSources: 3,
    completedSources: 3,
    currentSource: "/tmp/one.jsonl",
    changedSources: 3,
  });
  assert.deepEqual(status.result, {
    engine: "sqlite",
    durationMs: 3_250,
    totalSources: 9,
    changedSources: 3,
    skippedSources: 6,
    sessions: 3,
  });
  assert.ok(snapshots.some((snapshot) => snapshot.progress?.completedSources === 1));
  assert.equal(snapshots.at(-1).state, "succeeded");
});

test("sync event stream sends an initial snapshot and releases its listener", async () => {
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => newReport(),
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-sync-events.sqlite"),
    syncDatabase: async () => newReport(),
  });
  const server = await web.startWebServer(defaultOptions({
    preloadedReport: newReport(),
    host: "127.0.0.1",
    port: 0,
  }));
  const abort = new AbortController();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/sync/events`, { signal: abort.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = response.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /^data: /);
    assert.match(first, /"state":"idle"/);
    assert.match(first, /"available":true/);
    assert.equal(server.syncController.listenerCount(), 1);
    await reader.cancel();
    abort.abort();
    for (let i = 0; i < 20 && server.syncController.listenerCount() > 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(server.syncController.listenerCount(), 0);
  } finally {
    abort.abort();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
