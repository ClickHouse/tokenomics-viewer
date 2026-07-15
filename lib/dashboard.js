"use strict";
const fs = require('node:fs');
const { buildRecommendations } = require("./recommendations");

function serializableStats(stats = {}) {
  return {
    ...stats,
    costsUsd: {
      input: 0,
      cacheCreate5m: 0,
      cacheCreate30m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
      output: 0,
      ...(stats.costsUsd || {}),
    },
    pricedInput: stats.pricedInput || 0,
    pricedCacheCreate5m: stats.pricedCacheCreate5m || 0,
    pricedCacheCreate30m: stats.pricedCacheCreate30m || 0,
    pricedCacheCreate1h: stats.pricedCacheCreate1h || 0,
    pricedCacheRead: stats.pricedCacheRead || 0,
    pricedOutput: stats.pricedOutput || 0,
    pricedReasoningOutput: stats.pricedReasoningOutput || 0,
    visibleInputChars: stats.visibleInputChars || 0,
    visibleOutputChars: stats.visibleOutputChars || 0,
    visibleTotalChars: stats.visibleTotalChars || 0,
    visibleCharTokenSamples: stats.visibleCharTokenSamples || 0,
    visibleCharsPerTokenSum: stats.visibleCharsPerTokenSum || 0,
    visibleCharsPerTokenMin: stats.visibleCharsPerTokenMin ?? null,
    visibleCharsPerTokenMax: stats.visibleCharsPerTokenMax ?? null,
    visibleOutputTextChars: stats.visibleOutputTextChars || 0,
    visibleOutputTextTokens: stats.visibleOutputTextTokens || 0,
    outputCharTokenSamples: stats.outputCharTokenSamples || 0,
    outputCharsPerTokenSum: stats.outputCharsPerTokenSum || 0,
    outputCharsPerTokenMin: stats.outputCharsPerTokenMin ?? null,
    outputCharsPerTokenMax: stats.outputCharsPerTokenMax ?? null,
    outputCharsPerTokenP10: stats.outputCharsPerTokenP10 ?? null,
    outputCharsPerTokenP99: stats.outputCharsPerTokenP99 ?? null,
    outputCharTokenOutliers: stats.outputCharTokenOutliers || 0,
  };
}

function sortedEntries(data) {
  return Object.entries(data || {}).sort((a, b) => {
    const byCost = (b[1].costUsd || 0) - (a[1].costUsd || 0);
    if (byCost !== 0) return byCost;
    return (b[1].input || 0) + (b[1].cacheRead || 0) + (b[1].output || 0)
      - ((a[1].input || 0) + (a[1].cacheRead || 0) + (a[1].output || 0));
  });
}

function chronologicalEntries(data) {
  return Object.entries(data || {}).sort((a, b) => a[0].localeCompare(b[0]));
}

function serializableUsageStats(stats = {}) {
  return {
    requests: stats.requests || 0,
    pricedRequests: stats.pricedRequests || 0,
    unpricedRequests: stats.unpricedRequests || 0,
    input: stats.input || 0,
    cacheCreate5m: stats.cacheCreate5m || 0,
    cacheCreate30m: stats.cacheCreate30m || 0,
    cacheCreate1h: stats.cacheCreate1h || 0,
    cacheRead: stats.cacheRead || 0,
    output: stats.output || 0,
    reasoningOutput: stats.reasoningOutput || 0,
    pricedInput: stats.pricedInput || 0,
    pricedCacheCreate5m: stats.pricedCacheCreate5m || 0,
    pricedCacheCreate30m: stats.pricedCacheCreate30m || 0,
    pricedCacheCreate1h: stats.pricedCacheCreate1h || 0,
    pricedCacheRead: stats.pricedCacheRead || 0,
    pricedOutput: stats.pricedOutput || 0,
    pricedReasoningOutput: stats.pricedReasoningOutput || 0,
    costUsd: stats.costUsd || 0,
    costsUsd: {
      input: stats.costsUsd?.input || 0,
      cacheCreate5m: stats.costsUsd?.cacheCreate5m || 0,
      cacheCreate30m: stats.costsUsd?.cacheCreate30m || 0,
      cacheCreate1h: stats.costsUsd?.cacheCreate1h || 0,
      cacheRead: stats.costsUsd?.cacheRead || 0,
      output: stats.costsUsd?.output || 0,
    },
  };
}

function serializableTimelineStats(stats = {}) {
  return {
    requests: stats.requests || 0,
    pricedRequests: stats.pricedRequests || 0,
    input: stats.input || 0,
    cacheCreate5m: stats.cacheCreate5m || 0,
    cacheCreate30m: stats.cacheCreate30m || 0,
    cacheCreate1h: stats.cacheCreate1h || 0,
    cacheRead: stats.cacheRead || 0,
    output: stats.output || 0,
    costUsd: stats.costUsd || 0,
    costsUsd: {
      input: stats.costsUsd?.input || 0,
      cacheCreate5m: stats.costsUsd?.cacheCreate5m || 0,
      cacheCreate30m: stats.costsUsd?.cacheCreate30m || 0,
      cacheCreate1h: stats.costsUsd?.cacheCreate1h || 0,
      cacheRead: stats.costsUsd?.cacheRead || 0,
      output: stats.costsUsd?.output || 0,
    },
  };
}

function topStats(data, top) {
  return sortedEntries(data)
    .slice(0, top)
    .map(([name, stats]) => ({ name, ...serializableStats(stats) }));
}

function projectModelStats(projectProviderModels, project) {
  const rows = [];
  for (const [provider, models] of Object.entries(projectProviderModels?.[project] || {})) {
    for (const [model, stats] of Object.entries(models || {})) {
      rows.push({ provider, model, name: `${provider}/${model}`, ...serializableStats(stats) });
    }
  }
  return rows.sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));
}

function periodModelStats(providerModels = {}) {
  const rows = [];
  for (const [provider, models] of Object.entries(providerModels || {})) {
    for (const [model, stats] of Object.entries(models || {})) {
      rows.push({ provider, model, name: `${provider}/${model}`, ...serializableTimelineStats(stats) });
    }
  }
  return rows.sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));
}

function timelineStats(timeline, periodProviderModels) {
  return chronologicalEntries(timeline).map(([period, stats]) => ({
    name: period,
    ...serializableTimelineStats(stats),
    models: periodModelStats(periodProviderModels?.[period]),
  }));
}

function projectDailyStats(projectDaily, projects, projectProviderModels, top) {
  const names = sortedEntries(projects)
    .slice(0, top)
    .map(([name]) => name);
  return names.map((name) => ({
    name,
    ...serializableStats(projects[name]),
    daily: chronologicalEntries(projectDaily?.[name]).map(([day, stats]) => ({ name: day, ...serializableStats(stats) })),
    models: projectModelStats(projectProviderModels, name),
  }));
}

function webTimeline(report, options = {}) {
  const project = options.project;
  const timeline = project == null ? report.quarterHourly : report.projectQuarterHourly?.[project];
  const providerModels = project == null
    ? report.quarterHourlyProviderModels
    : report.projectQuarterHourlyProviderModels?.[project];
  let rows = timelineStats(timeline, providerModels);
  if (Number.isInteger(options.days) && options.days > 0 && rows.length) {
    const lastDay = Date.parse(rows.at(-1).name.slice(0, 10) + "T00:00:00Z");
    const cutoff = lastDay - (options.days - 1) * 86_400_000;
    rows = rows.filter((row) => Date.parse(row.name) >= cutoff);
  }
  if (options.from) {
    const from = Date.parse(`${options.from}T00:00:00Z`);
    rows = rows.filter((row) => Date.parse(row.name) >= from);
  }
  if (options.to) {
    const toExclusive = Date.parse(`${options.to}T00:00:00Z`) + 86_400_000;
    rows = rows.filter((row) => Date.parse(row.name) < toExclusive);
  }
  return rows;
}

function providerModelEffortDailyStats(data) {
  const groups = [];
  for (const [provider, models] of Object.entries(data || {})) {
    for (const [model, efforts] of Object.entries(models || {})) {
      for (const [effort, daily] of Object.entries(efforts || {})) {
        const rows = chronologicalEntries(daily).map(([day, stats]) => ({ name: day, ...serializableUsageStats(stats) }));
        groups.push({
          provider,
          model,
          effort,
          daily: rows,
          costUsd: rows.reduce((sum, row) => sum + (row.costUsd || 0), 0),
        });
      }
    }
  }
  return groups.sort((a, b) => b.costUsd - a.costUsd || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.effort.localeCompare(b.effort));
}

function webSummary(report, options = {}) {
  const top = options.top || 25;
  return {
    generatedAt: new Date().toISOString(),
    sources: report.sources,
    total: serializableStats(report.total),
    topModels: topStats(report.models, top),
    models: topStats(report.models, Number.MAX_SAFE_INTEGER),
    topProjects: topStats(report.projects, top),
    topEfforts: topStats(report.efforts, top),
    daily: chronologicalEntries(report.daily).map(([name, stats]) => ({ name, ...serializableStats(stats) })),
    weekly: chronologicalEntries(report.weekly).map(([name, stats]) => ({ name, ...serializableStats(stats) })),
    monthly: chronologicalEntries(report.monthly).map(([name, stats]) => ({ name, ...serializableStats(stats) })),
    projectDaily: projectDailyStats(report.projectDaily, report.projects, report.projectProviderModels, top),
    configurationRevision: report.configurationRevision || null,
    pricingBasis: report.pricingBasis || "standard",
    regionalMultiplier: report.regionalMultiplier ?? 1,
    pricingStale: Boolean(report.pricingStale),
    providerModelEffortDaily: providerModelEffortDailyStats(report.providerModelEffortDaily),
    rateLimits: report.rateLimits,
    unpricedModels: Object.values(report.unpricedModels || {}).sort((a, b) => b.requests - a.requests),
    recommendations: buildRecommendations(report),
  };
}

function dashboardHtml() {
  return fs.readFileSync(__dirname + "/../public/index.html", "utf8");
}

function timelineJavascript() {
  return fs.readFileSync(__dirname + "/../public/timeline.js", "utf8");
}

module.exports = {
  dashboardHtml,
  timelineJavascript,
  webSummary,
  webTimeline,
};
