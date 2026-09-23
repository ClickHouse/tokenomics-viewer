"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  diagnosticId,
  reportMetric,
  sourceReportMetric,
  syncMetricLine,
} = require("../lib/core/sync-diagnostics");

test("sync diagnostics expose stable metrics without raw identifiers", () => {
  const privatePath = "/Users/example/.codex/sessions/private.jsonl";
  const report = {
    total: {
      requests: 3,
      input: 11,
      cacheCreate5m: 2,
      cacheCreate30m: 3,
      cacheCreate1h: 4,
      cacheRead: 7,
      output: 5,
      reasoningOutput: 1,
      costUsd: 0.25,
      pricedRequests: 2,
      unpricedRequests: 1,
    },
    monthly: {},
    daily: { "2026-09-16": {}, "2026-09-15": {} },
    models: { "gpt-5.6-luna": { requests: 3, costUsd: 0.25 } },
    agents: { codex: { requests: 3, costUsd: 0.25 } },
    serviceModes: { standard: { requests: 3, costUsd: 0.25 } },
    sessions: [{ durationMs: 12, lines: 8, records: 6 }],
    sources: {
      files: 1,
      parseErrors: 1,
      tokenCountSnapshots: 4,
      skippedTokenCountSnapshots: 2,
      duplicateUsageEvents: 2,
      conflictingUsageEvents: 0,
    },
    provenance: {
      generationId: "generation-private-id",
      sourceManifestDigest: "source-manifest-private-digest",
      eventSetDigest: "event-set-private-digest",
      dataThrough: "2026-09-16T11:59:00.000Z",
      codexUsageDerivationComplete: true,
    },
  };
  report.monthly["2026-09"] = report.total;

  const sourceId = diagnosticId(privatePath);
  const line = syncMetricLine("source_import", {
    sourceId,
    ...sourceReportMetric(report),
  });
  const snapshot = reportMetric(report, new Date("2026-09-16T12:00:00.000Z"));

  assert.equal(sourceId, diagnosticId(privatePath));
  assert.equal(sourceId.length, 16);
  assert.equal(line.includes(privatePath), false);
  assert.match(line, /^\[sync-metric\] \{"event":"source_import"/);
  assert.equal(JSON.parse(line.slice("[sync-metric] ".length)).cacheCreateTokens, 9);
  assert.equal(JSON.parse(line.slice("[sync-metric] ".length)).models.values["gpt-5.6-luna"].requests, 3);
  assert.equal(JSON.parse(line.slice("[sync-metric] ".length)).usageStartDay, "2026-09-15");
  assert.equal(snapshot.month, "2026-09");
  assert.equal(snapshot.currentMonth.costUsd, 0.25);
  assert.equal(snapshot.sources.skippedTokenCountSnapshots, 2);
  assert.equal(snapshot.sources.duplicateUsageEvents, 2);
  assert.equal(snapshot.provenance.generationId, diagnosticId("generation-private-id"));
  assert.equal(snapshot.provenance.sourceManifestId, diagnosticId("source-manifest-private-digest"));
  assert.equal(snapshot.provenance.eventSetId, diagnosticId("event-set-private-digest"));
  assert.equal(snapshot.provenance.dataThrough, "2026-09-16T11:59:00.000Z");
  assert.equal(snapshot.provenance.codexUsageDerivationComplete, true);
});
