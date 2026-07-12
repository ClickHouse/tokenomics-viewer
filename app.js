#!/usr/bin/env node
"use strict";

const { createLineProcessor } = require("./lib/ingest/parser");
const { createIngestSources } = require("./lib/ingest/sources");
const {
  addUsage,
} = require("./lib/core/aggregate");
const {
  PRICING,
  PRICING_SOURCES,
  calculateCost,
} = require("./lib/core/pricing");
const { finalizeRateLimits } = require("./lib/core/rate-limits");
const {
  newReport,
} = require("./lib/core/report-model");
const {
  usageFromClaudeUsage,
  usageFromCodexInfo,
} = require("./lib/core/usage");
const reportText = require("./lib/report/text");
const cli = require("./lib/cli");
const { createStorage } = require("./lib/storage");
const { createWebServer } = require("./lib/web-server");

const ingest = createIngestSources({
  finishSession: reportText.finishSession,
  formatBytes: reportText.formatBytes,
  formatInt: reportText.formatInt,
  logProgress: reportText.logProgress,
  startSession: reportText.startSession,
});

const storage = createStorage({
  ingest,
  formatBytes: reportText.formatBytes,
  formatInt: reportText.formatInt,
  logProgress: reportText.logProgress,
});

const web = createWebServer({
  buildReportFromSelectedDatabase: storage.buildReportFromSelectedDatabase,
  resolveDbPath: storage.resolveDbPath,
  syncDatabase: storage.syncDatabase,
});

// Keep the historical app.parseArgs --help side effect for consumers of app.js.
function parseArgs(argv) {
  const options = cli.parseArgs(argv);
  if (options.help) {
    cli.printHelp();
    process.exit(0);
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = cli.parseArgs(argv);
  if (options.help) {
    cli.printHelp();
    return options;
  }
  if (options.webserver) {
    let preloadedReport = null;
    if (options.webserverSync) {
      preloadedReport = await storage.syncDatabase(options);
    }
    const server = await web.startWebServer({ ...options, preloadedReport });
    const address = server.address();
    const host = address.address === "::" ? "localhost" : address.address;
    reportText.logProgress(options, `[webserver] http://${host}:${address.port}`);
    return server;
  }
  if (options.sync) {
    const report = await storage.syncDatabase(options);
    await reportText.writeReport(report, options);
    return report;
  }
  if (storage.selectedDbEngine(options) === "clickhouse") {
    const report = await storage.buildReportFromClickHouse(options);
    await reportText.writeReport(report, options);
    return report;
  }
  const report = await ingest.buildReport(options);
  await reportText.writeReport(report, options);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  PRICING,
  PRICING_SOURCES,
  addUsage,
  buildReportFromClickHouse: storage.buildReportFromClickHouse,
  buildReportFromDatabase: storage.buildReportFromDatabase,
  buildReport: ingest.buildReport,
  calculateCost,
  createLineProcessor,
  discoverInputs: ingest.discoverInputs,
  finalizeRateLimits,
  main,
  newReport,
  parseArgs,
  processJsonlFile: ingest.processJsonlFile,
  processZipFile: ingest.processZipFile,
  renderReport: reportText.renderReport,
  startWebServer: web.startWebServer,
  syncDatabase: storage.syncDatabase,
  usageFromClaudeUsage,
  usageFromCodexInfo,
  writeReport: reportText.writeReport,
};
