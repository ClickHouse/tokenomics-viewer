"use strict";

const http = require("node:http");
const { URL } = require("node:url");
const dashboard = require("./dashboard");

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

function createSyncController({ syncDatabase, reportCache, options, now = () => new Date() }) {
  if (typeof syncDatabase !== "function") throw new TypeError("createSyncController requires a sync function");
  if (!reportCache || typeof reportCache.set !== "function") {
    throw new TypeError("createSyncController requires a replaceable report cache");
  }

  let runId = 0;
  let pending = null;
  let status = {
    state: "idle",
    runId,
    startedAt: null,
    finishedAt: null,
    error: null,
  };

  function getStatus() {
    return { ...status };
  }

  function start() {
    if (pending) return { started: false, sync: getStatus() };

    runId += 1;
    status = {
      state: "running",
      runId,
      startedAt: now().toISOString(),
      finishedAt: null,
      error: null,
    };
    pending = Promise.resolve()
      .then(() => syncDatabase(options))
      .then((report) => {
        reportCache.set(report);
        status = {
          ...status,
          state: "succeeded",
          finishedAt: now().toISOString(),
        };
      })
      .catch((error) => {
        status = {
          ...status,
          state: "failed",
          finishedAt: now().toISOString(),
          error: error?.message || String(error),
        };
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

  return { getStatus, start, waitForIdle };
}

function createWebServer({
  buildReportFromSelectedDatabase,
  resolveDbPath,
  syncDatabase,
} = {}) {
  async function handleWebRequest(request, response, options) {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    try {
      if (url.pathname === "/api/sync") {
        if (!options.syncController) {
          sendJson(response, { error: "sync unavailable" }, 501);
          return;
        }
        if (request.method === "GET") {
          sendJson(response, { sync: options.syncController.getStatus() });
          return;
        }
        if (request.method === "POST") {
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
  sendHtml,
  sendJson,
};
