"use strict";
const fs = require('node:fs');

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

function topStats(data, top) {
  return sortedEntries(data)
    .slice(0, top)
    .map(([name, stats]) => ({ name, ...serializableStats(stats) }));
}

function projectDailyStats(projectDaily, projects, top) {
  const names = sortedEntries(projects)
    .slice(0, top)
    .map(([name]) => name);
  return names.map((name) => ({
    name,
    ...serializableStats(projects[name]),
    daily: chronologicalEntries(projectDaily?.[name]).map(([day, stats]) => ({ name: day, ...serializableStats(stats) })),
  }));
}

function webSummary(report, options = {}) {
  const top = options.top || 25;
  return {
    generatedAt: new Date().toISOString(),
    sources: report.sources,
    total: serializableStats(report.total),
    topModels: topStats(report.models, top),
    topProjects: topStats(report.projects, top),
    topEfforts: topStats(report.efforts, top),
    daily: chronologicalEntries(report.daily).map(([name, stats]) => ({ name, ...serializableStats(stats) })),
    weekly: chronologicalEntries(report.weekly).map(([name, stats]) => ({ name, ...serializableStats(stats) })),
    monthly: chronologicalEntries(report.monthly).map(([name, stats]) => ({ name, ...serializableStats(stats) })),
    projectDaily: projectDailyStats(report.projectDaily, report.projects, top),
    rateLimits: report.rateLimits,
    unpricedModels: Object.values(report.unpricedModels || {}).sort((a, b) => b.requests - a.requests),
  };
}

function dashboardHtml() {
  return fs.readFileSync(__dirname + "/../public/index.html", "utf8");
}

module.exports = {
  dashboardHtml,
  webSummary,
};
