"use strict";

const { createHash } = require("node:crypto");

function diagnosticId(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function statsMetric(stats = {}) {
  return {
    requests: Number(stats.requests) || 0,
    inputTokens: Number(stats.input) || 0,
    cacheCreateTokens: (
      (Number(stats.cacheCreate5m) || 0)
      + (Number(stats.cacheCreate30m) || 0)
      + (Number(stats.cacheCreate1h) || 0)
    ),
    cacheReadTokens: Number(stats.cacheRead) || 0,
    outputTokens: Number(stats.output) || 0,
    reasoningOutputTokens: Number(stats.reasoningOutput) || 0,
    costUsd: Number(stats.costUsd) || 0,
    pricedRequests: Number(stats.pricedRequests) || 0,
    unpricedRequests: Number(stats.unpricedRequests) || 0,
  };
}

function dimensionMetric(buckets = {}, limit = 20) {
  const entries = Object.entries(buckets)
    .sort(([, left], [, right]) => (
      (Number(right.requests) || 0) - (Number(left.requests) || 0)
    ));
  return {
    values: Object.fromEntries(entries.slice(0, limit).map(([key, stats]) => [key, statsMetric(stats)])),
    omitted: Math.max(0, entries.length - limit),
  };
}

function sourceReportMetric(report = {}) {
  const sessions = report.sessions || [];
  const usageDays = Object.keys(report.daily || {}).sort();
  return {
    ...statsMetric(report.total),
    sessions: sessions.length,
    durationMs: sessions.reduce((sum, session) => sum + (Number(session.durationMs) || 0), 0),
    lines: sessions.reduce((sum, session) => sum + (Number(session.lines) || 0), 0),
    records: sessions.reduce((sum, session) => sum + (Number(session.records) || 0), 0),
    parseErrors: Number(report.sources?.parseErrors) || 0,
    tokenCountSnapshots: Number(report.sources?.tokenCountSnapshots) || 0,
    skippedTokenCountSnapshots: Number(report.sources?.skippedTokenCountSnapshots) || 0,
    usageStartDay: usageDays[0] || null,
    usageEndDay: usageDays.at(-1) || null,
    models: dimensionMetric(report.models),
    agents: dimensionMetric(report.agents),
    serviceModes: dimensionMetric(report.serviceModes),
  };
}

function reportMetric(report = {}, now = new Date()) {
  const month = Number.isFinite(now?.getTime?.())
    ? now.toISOString().slice(0, 7)
    : null;
  return {
    month,
    total: statsMetric(report.total),
    currentMonth: statsMetric(month ? report.monthly?.[month] : null),
    sources: {
      files: Number(report.sources?.files) || 0,
      zipFiles: Number(report.sources?.zipFiles) || 0,
      zipEntries: Number(report.sources?.zipEntries) || 0,
      parseErrors: Number(report.sources?.parseErrors) || 0,
      skippedFiles: Number(report.sources?.skippedFiles) || 0,
      tokenCountSnapshots: Number(report.sources?.tokenCountSnapshots) || 0,
      skippedTokenCountSnapshots: Number(report.sources?.skippedTokenCountSnapshots) || 0,
      duplicateUsageEvents: Number(report.sources?.duplicateUsageEvents) || 0,
      conflictingUsageEvents: Number(report.sources?.conflictingUsageEvents) || 0,
    },
    provenance: {
      generationId: report.provenance?.generationId ? diagnosticId(report.provenance.generationId) : null,
      sourceManifestId: report.provenance?.sourceManifestDigest
        ? diagnosticId(report.provenance.sourceManifestDigest)
        : null,
      eventSetId: report.provenance?.eventSetDigest ? diagnosticId(report.provenance.eventSetDigest) : null,
      dataThrough: report.provenance?.dataThrough || null,
      codexUsageDerivationComplete: report.provenance?.codexUsageDerivationComplete ?? null,
    },
  };
}

function syncMetricLine(event, fields = {}) {
  return `[sync-metric] ${JSON.stringify({ event, ...fields })}`;
}

module.exports = {
  diagnosticId,
  dimensionMetric,
  reportMetric,
  sourceReportMetric,
  statsMetric,
  syncMetricLine,
};
