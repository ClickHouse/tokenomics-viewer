"use strict";

const {
  ANALYTICS_DERIVATION_VERSION,
  CODEX_USAGE_DERIVATION_VERSION,
} = require("./derivation");
const { canonicalJson, sha256 } = require("./usage-event-identity");

const RECEIPT_CONTRACT_VERSION = 1;
const CLOSED_DAY_FIELDS = [
  "requests",
  "input",
  "cacheCreate5m",
  "cacheCreate30m",
  "cacheCreate1h",
  "cacheRead",
  "output",
  "reasoningOutput",
];

function validIso(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function dataThrough(report) {
  let latest = null;
  for (const session of report.sessions || []) {
    const candidate = validIso(session.finishedAt) || validIso(session.startedAt);
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  if (latest) return latest;
  for (const day of Object.keys(report.daily || {})) {
    const candidate = validIso(`${day}T23:59:59.999Z`);
    if (candidate && (!latest || candidate > latest)) latest = candidate;
  }
  return latest;
}

function reportProjection(report) {
  return {
    total: report.total,
    daily: report.daily,
    providers: report.providers,
    models: report.models,
    projects: report.projects,
    efforts: report.efforts,
    serviceTiers: report.serviceTiers,
    serviceModes: report.serviceModes,
    agents: report.agents,
  };
}

function sourceProjection(report) {
  return (report.sessions || []).map((session) => ({
    kind: session.kind,
    path: session.path,
    archivePath: session.archivePath || null,
    entryName: session.entryName || null,
    sizeBytes: session.sizeBytes ?? null,
    compressedSizeBytes: session.compressedSizeBytes ?? null,
    records: session.records,
    parseErrors: session.parseErrors,
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function buildReportReceipt(report, options = {}) {
  const committedAt = validIso(options.committedAt)
    || validIso(report.receipt?.committedAt)
    || validIso(report.provenance?.committedAt)
    || new Date().toISOString();
  const reportDigest = sha256(canonicalJson(reportProjection(report)));
  const sourceManifestDigest = report.provenance?.sourceManifestDigest
    || sha256(canonicalJson(sourceProjection(report)));
  const eventSetDigest = report.provenance?.eventSetDigest || null;
  const core = {
    contractVersion: RECEIPT_CONTRACT_VERSION,
    generationId: report.provenance?.generationId || null,
    configurationRevision: report.configurationRevision || null,
    pricingRevision: report.pricingRevision || null,
    analyticsDerivationVersion: ANALYTICS_DERIVATION_VERSION,
    codexUsageDerivationVersion: CODEX_USAGE_DERIVATION_VERSION,
    codexUsageDerivationComplete: report.provenance?.codexUsageDerivationComplete ?? null,
    sourceManifestDigest,
    eventSetDigest,
    reportDigest,
    dataThrough: report.provenance?.dataThrough || dataThrough(report),
  };
  return {
    ...core,
    receiptId: sha256(canonicalJson(core)),
    committedAt,
    runtimeId: options.runtimeId || report.receipt?.runtimeId || null,
    syncRunId: Number.isSafeInteger(options.syncRunId) ? options.syncRunId : (report.receipt?.syncRunId ?? null),
  };
}

function attachReportReceipt(report, options = {}) {
  return {
    ...report,
    receipt: buildReportReceipt(report, options),
  };
}

function closedDaySeries(report) {
  const series = new Map([["daily", report.daily || {}]]);
  for (const [provider, models] of Object.entries(report.providerModelEffortDaily || {})) {
    for (const [model, efforts] of Object.entries(models || {})) {
      for (const [effort, days] of Object.entries(efforts || {})) {
        series.set(`provider-model-effort:${provider}/${model}/${effort}`, days || {});
      }
    }
  }
  return series;
}

function closedDayDrift(previous, candidate, now = new Date()) {
  if (!previous || !candidate) return { classification: "initial", changes: [], additions: [], decreases: [] };
  const currentDay = now.toISOString().slice(0, 10);
  const previousSeries = closedDaySeries(previous);
  const candidateSeries = closedDaySeries(candidate);
  const scopes = new Set([...previousSeries.keys(), ...candidateSeries.keys()]);
  const changes = [];
  const decreases = [];
  for (const scope of [...scopes].sort()) {
    const beforeDays = previousSeries.get(scope) || {};
    const afterDays = candidateSeries.get(scope) || {};
    const days = new Set([...Object.keys(beforeDays), ...Object.keys(afterDays)]);
    for (const day of [...days].sort()) {
      if (day >= currentDay) continue;
      const before = beforeDays[day] || {};
      const after = afterDays[day] || {};
      for (const field of CLOSED_DAY_FIELDS) {
        const left = Number(before[field]) || 0;
        const right = Number(after[field]) || 0;
        if (right < left) {
          decreases.push({ scope, day, field, before: left, after: right });
        }
        if (right > left) changes.push({ scope, day, field, before: left, after: right });
      }
    }
  }
  const derivationRebuild = previous.provenance?.codexUsageDerivationComplete === false
    && candidate.provenance?.codexUsageDerivationComplete === true;
  if (decreases.length > 0 && !derivationRebuild) {
    const first = decreases[0];
    const error = new Error(`Closed-day usage drift rejected for ${first.scope} ${first.day}: ${first.field} ${first.before} -> ${first.after}`);
    error.code = "CLOSED_DAY_USAGE_DRIFT";
    error.scope = first.scope;
    error.day = first.day;
    error.field = first.field;
    error.changes = decreases;
    throw error;
  }
  return {
    classification: derivationRebuild && decreases.length > 0
      ? "derivation-rebuild"
      : (changes.length > 0 ? "late-arrival" : "stable"),
    changes: [...changes, ...decreases],
    additions: changes,
    decreases,
  };
}

module.exports = {
  RECEIPT_CONTRACT_VERSION,
  attachReportReceipt,
  buildReportReceipt,
  closedDayDrift,
  dataThrough,
};
