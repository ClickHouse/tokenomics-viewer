"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const dashboard = require("./dashboard");

const MAX_SYNC_EVENT_CLIENTS = 16;

function sendJson(response, value, status = 200) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendHtml(response, body, status = 200) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function createReportCache(buildReport, initialReport = null) {
  if (typeof buildReport !== "function") throw new TypeError("createReportCache requires a report builder");
  let report = initialReport;
  let pending = null;
  let revision = 0;
  return {
    async get() {
      if (report) return report;
      if (!pending) {
        const buildRevision = revision;
        pending = Promise.resolve(buildReport())
          .then((built) => {
            if (revision === buildRevision) report = built;
            return report || built;
          })
          .finally(() => {
            pending = null;
          });
      }
      return pending;
    },
    set(nextReport) {
      revision += 1;
      report = nextReport;
    },
  };
}

function isLoopbackHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  if (normalized === "localhost" || normalized === "::1" || normalized === "[::1]") return true;
  const match = normalized.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(match && match.slice(1).every((part) => Number(part) <= 255));
}

function boundedText(value, maxLength = 2_000) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function createSyncController({ syncDatabase, reportCache, options, now = () => new Date() }) {
  if (typeof syncDatabase !== "function") throw new TypeError("createSyncController requires a sync function");
  if (!reportCache || typeof reportCache.set !== "function") {
    throw new TypeError("createSyncController requires a replaceable report cache");
  }

  let runId = 0;
  let pending = null;
  const listeners = new Set();
  let status = {
    state: "idle",
    runId,
    startedAt: null,
    finishedAt: null,
    error: null,
    progress: null,
    result: null,
  };

  function getStatus() {
    return {
      ...status,
      progress: status.progress ? { ...status.progress } : null,
      result: status.result ? { ...status.result } : null,
    };
  }

  function notify() {
    const snapshot = getStatus();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A disconnected observer must not interrupt the database transaction.
      }
    }
  }

  function updateProgress(event = {}) {
    if (status.state !== "running") return;
    const progress = { ...(status.progress || {}) };
    if (typeof event.phase === "string") progress.phase = event.phase;
    if (event.currentSource === null || typeof event.currentSource === "string") {
      progress.currentSource = event.currentSource === null ? null : boundedText(event.currentSource, 1_000);
    }
    for (const key of ["totalSources", "candidateSources", "completedSources", "changedSources", "bytesProcessed"]) {
      if (Number.isFinite(event[key])) progress[key] = Math.max(0, Math.floor(event[key]));
    }
    if (event.sourceCompleted) {
      progress.completedSources = Math.max(0, Number(progress.completedSources) || 0) + 1;
      progress.bytesProcessed = Math.max(0, Number(progress.bytesProcessed) || 0)
        + Math.max(0, Number(event.bytesProcessed) || 0);
    }
    status = { ...status, progress };
    notify();
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("sync listener must be a function");
    listeners.add(listener);
    try {
      listener(getStatus());
    } catch {
      // Keep observer failures outside the sync lifecycle.
    }
    return () => listeners.delete(listener);
  }

  function start() {
    if (pending) return { started: false, sync: getStatus() };

    runId += 1;
    const started = now();
    status = {
      state: "running",
      runId,
      startedAt: started.toISOString(),
      finishedAt: null,
      error: null,
      progress: null,
      result: null,
    };
    const startedAtMs = started.getTime();
    notify();
    const upstreamProgress = options.onSyncProgress;
    const syncOptions = {
      ...options,
      onSyncProgress(event) {
        updateProgress(event);
        if (typeof upstreamProgress === "function") {
          try {
            upstreamProgress(event);
          } catch {
            // External telemetry is observational and cannot abort sync.
          }
        }
      },
    };
    pending = Promise.resolve()
      .then(() => syncDatabase(syncOptions))
      .then((report) => {
        reportCache.set(report);
        const finished = now();
        const progress = status.progress || {};
        const totalSources = Math.max(0, Number(progress.totalSources) || 0);
        const changedSources = Math.max(0, Number(progress.changedSources) || 0);
        status = {
          ...status,
          state: "succeeded",
          finishedAt: finished.toISOString(),
          result: {
            engine: options.dbEngine || "sqlite",
            durationMs: Math.max(0, finished.getTime() - startedAtMs),
            totalSources,
            changedSources,
            skippedSources: Math.max(0, totalSources - changedSources),
            sessions: Array.isArray(report?.sessions) ? report.sessions.length : 0,
          },
        };
        notify();
      })
      .catch((error) => {
        status = {
          ...status,
          state: "failed",
          finishedAt: now().toISOString(),
          error: boundedText(error?.message || String(error)),
        };
        notify();
      })
      .finally(() => {
        pending = null;
      });

    return { started: true, sync: getStatus() };
  }

  async function waitForIdle() {
    if (pending) await pending;
    return getStatus();
  }

  return {
    getStatus,
    listenerCount: () => listeners.size,
    start,
    subscribe,
    waitForIdle,
  };
}

function syncStatusPayload(options) {
  const available = Boolean(options.syncAllowed && options.syncController);
  return {
    ...options.syncController.getStatus(),
    available,
    unavailableReason: available ? null : "Sync is only available when the webserver is bound to a loopback host.",
  };
}

function sendSyncEvents(request, response, options) {
  if (options.syncEventResponses.size >= MAX_SYNC_EVENT_CLIENTS) {
    sendJson(response, { error: "too many sync event clients" }, 429);
    return;
  }
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders?.();
  options.syncEventResponses.add(response);
  let blocked = false;
  let queued = null;
  const writeSnapshot = (snapshot) => {
    const payload = `data: ${JSON.stringify({ sync: snapshot })}\n\n`;
    if (blocked) {
      queued = payload;
      return;
    }
    blocked = !response.write(payload);
  };
  const unsubscribe = options.syncController.subscribe(() => {
    writeSnapshot(syncStatusPayload(options));
  });
  const onDrain = () => {
    blocked = false;
    if (!queued) return;
    const payload = queued;
    queued = null;
    blocked = !response.write(payload);
  };
  response.on("drain", onDrain);
  const heartbeat = setInterval(() => {
    if (!blocked) blocked = !response.write(": keep-alive\n\n");
  }, 15_000);
  heartbeat.unref?.();
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    response.off("drain", onDrain);
    queued = null;
    unsubscribe();
    options.syncEventResponses.delete(response);
  };
  request.once("close", cleanup);
  response.once("close", cleanup);
}

function createWebServer({
  buildReportFromSelectedDatabase,
  resolveDbPath,
  syncDatabase,
} = {}) {
  async function handleWebRequest(request, response, options) {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    try {
      if (url.pathname === "/api/sync/events") {
        if (!options.syncController) {
          sendJson(response, { error: "sync unavailable" }, 501);
        } else if (request.method !== "GET") {
          sendJson(response, { error: "method not allowed" }, 405);
        } else {
          sendSyncEvents(request, response, options);
        }
        return;
      }
      if (url.pathname === "/api/sync") {
        if (!options.syncController) {
          sendJson(response, { error: "sync unavailable" }, 501);
          return;
        }
        if (request.method === "GET") {
          sendJson(response, { sync: syncStatusPayload(options) });
          return;
        }
        if (request.method === "POST") {
          if (!options.syncAllowed) {
            sendJson(response, { error: "sync is disabled for non-loopback webserver bindings" }, 403);
            return;
          }
          const action = request.headers["x-tokenomics-action"];
          const fetchSite = request.headers["sec-fetch-site"];
          if (action !== "sync" || fetchSite === "cross-site") {
            sendJson(response, { error: "sync request rejected" }, 403);
            return;
          }
          sendJson(response, options.syncController.start(), 202);
          return;
        }
        sendJson(response, { error: "method not allowed" }, 405);
        return;
      }

      if (request.method !== "GET") {
        sendJson(response, { error: "method not allowed" }, 405);
        return;
      }

      if (url.pathname === "/") {
        sendHtml(response, await dashboard.dashboardHtml());
        return;
      }
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204, { "cache-control": "no-store" });
        response.end();
        return;
      }

      if (!["/api/report", "/api/summary", "/api/sessions"].includes(url.pathname)) {
        sendJson(response, { error: "not found" }, 404);
        return;
      }

      const report = await options.reportCache.get();
      if (url.pathname === "/api/report") {
        sendJson(response, report);
      } else if (url.pathname === "/api/summary") {
        sendJson(response, dashboard.webSummary(report, options));
      } else if (url.pathname === "/api/sessions") {
        sendJson(response, report.sessions.slice().sort((a, b) => b.stats.costUsd - a.stats.costUsd));
      }
    } catch (error) {
      sendJson(response, { error: error.message }, 500);
    }
  }

  async function startWebServer(options) {
    const db = resolveDbPath(options);
    const reportOptions = { ...options, db };
    const serverOptions = {
      ...reportOptions,
      syncAllowed: isLoopbackHost(options.host),
      syncEventResponses: new Set(),
      reportCache: options.reportCache || createReportCache(
        () => buildReportFromSelectedDatabase(reportOptions),
        options.preloadedReport || null,
      ),
    };
    if (typeof syncDatabase === "function") {
      serverOptions.syncController = createSyncController({
        syncDatabase,
        reportCache: serverOptions.reportCache,
        options: reportOptions,
      });
    }
    const server = http.createServer((request, response) => {
      handleWebRequest(request, response, serverOptions).catch((error) => {
        sendJson(response, { error: error.message }, 500);
      });
    });
    const closeServer = server.close.bind(server);
    server.close = (callback) => {
      for (const response of serverOptions.syncEventResponses) response.end();
      return closeServer(callback);
    };
    server.syncController = serverOptions.syncController || null;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server;
  }

  return {
    handleWebRequest,
    startWebServer,
  };
}

module.exports = {
  createReportCache,
  createSyncController,
  createWebServer,
  isLoopbackHost,
  sendHtml,
  sendJson,
};
