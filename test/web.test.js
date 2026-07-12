"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { newReport, startWebServer, syncDatabase } = require("../app");
const { createReportCache, createWebServer } = require("../lib/web-server");
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
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const oldReport = { ...newReport(), marker: "old" };
  const newReportValue = { ...newReport(), marker: "new" };
  const web = createWebServer({
    buildReportFromSelectedDatabase: async () => oldReport,
    resolveDbPath: () => Path.join(os.tmpdir(), "tokenomics-coalesced-sync.sqlite"),
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
