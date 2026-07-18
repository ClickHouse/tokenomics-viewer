"use strict";
const fs = require('node:fs');
const { buildRecommendations } = require("./recommendations");
const { dateKey, monthKey } = require("./core/report-model");

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
  if (options.fromAt) {
    const fromAt = Date.parse(options.fromAt);
    rows = rows.filter((row) => Date.parse(row.name) >= fromAt);
  }
  if (options.toAt) {
    const toAt = Date.parse(options.toAt);
    rows = rows.filter((row) => Date.parse(row.name) < toAt);
  }
  return rows;
}

function normalizedUsageProfile(report) {
  const source = report.usageProfile || {};
  const mode = source.mode === "subscription" ? "subscription" : "api";
  return {
    id: source.id || "default",
    name: source.name || (mode === "subscription" ? "Home Subscription" : "Work API"),
    mode,
  };
}

function addWindowModel(target, provider, model, stats) {
  const name = `${provider}/${model}`;
  const current = target.get(name) || {
    name,
    provider,
    model,
    requests: 0,
    pricedRequests: 0,
    costUsd: 0,
  };
  current.requests += stats.requests || 0;
  current.pricedRequests += stats.pricedRequests || 0;
  current.costUsd += stats.costUsd || 0;
  target.set(name, current);
}

function subscriptionWindowSummaries(report, now) {
  const timelineEntries = chronologicalEntries(report.quarterHourly);
  const timelineStartMs = timelineEntries.length ? Date.parse(timelineEntries[0][0]) : Number.NaN;
  const windows = [];
  for (const [key, stats] of Object.entries(report.rateLimits?.windows || {})) {
    const windowMinutes = Number(stats.windowMinutes);
    const latestAtMs = Date.parse(stats.latestAt || "");
    if (!Number.isFinite(windowMinutes) || windowMinutes <= 0 || !Number.isFinite(latestAtMs)) continue;
    const resetAtMs = Number(stats.latestResetAt) > 0 ? Number(stats.latestResetAt) * 1_000 : Number.NaN;
    const windowEndMs = Number.isFinite(resetAtMs) ? resetAtMs : latestAtMs;
    const windowStartMs = windowEndMs - windowMinutes * 60_000;
    const observedThroughMs = Math.min(latestAtMs, now.getTime());
    const totals = { requests: 0, pricedRequests: 0, costUsd: 0 };
    const models = new Map();
    for (const [period, row] of timelineEntries) {
      const periodMs = Date.parse(period);
      if (!Number.isFinite(periodMs) || periodMs < windowStartMs || periodMs > observedThroughMs) continue;
      totals.requests += row.requests || 0;
      totals.pricedRequests += row.pricedRequests || 0;
      totals.costUsd += row.costUsd || 0;
      for (const [provider, providerModels] of Object.entries(report.quarterHourlyProviderModels?.[period] || {})) {
        for (const [model, modelStats] of Object.entries(providerModels || {})) {
          addWindowModel(models, provider, model, modelStats);
        }
      }
    }
    const observableMs = Math.max(1, observedThroughMs - windowStartMs);
    const observedFromMs = Number.isFinite(timelineStartMs) ? Math.max(windowStartMs, timelineStartMs) : observedThroughMs;
    const timeCoverage = Math.max(0, Math.min(1, (observedThroughMs - observedFromMs) / observableMs));
    const usedPercent = stats.latestUsedPercent == null ? null : Number(stats.latestUsedPercent);
    const pricingCoverage = totals.requests > 0 ? totals.pricedRequests / totals.requests : null;
    const completeForUnitEstimate = timeCoverage >= 0.99 && pricingCoverage !== null && pricingCoverage >= 0.99 && usedPercent > 0;
    windows.push({
      key,
      limitId: stats.limitId || null,
      kind: stats.kind || null,
      planType: stats.planType || null,
      windowMinutes,
      usedPercent,
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      latestAt: new Date(latestAtMs).toISOString(),
      resetAt: Number.isFinite(resetAtMs) ? new Date(resetAtMs).toISOString() : null,
      observedFrom: new Date(observedFromMs).toISOString(),
      apiEquivalentCostUsd: totals.costUsd,
      apiEquivalentPerQuotaPointUsd: completeForUnitEstimate ? totals.costUsd / usedPercent : null,
      projectedFullWindowApiEquivalentUsd: completeForUnitEstimate ? totals.costUsd * 100 / usedPercent : null,
      requests: totals.requests,
      pricedRequests: totals.pricedRequests,
      pricingCoverage,
      timeCoverage,
      models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name)),
    });
  }
  return windows.sort((a, b) => a.windowMinutes - b.windowMinutes || a.key.localeCompare(b.key));
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
  const requestedNow = typeof options.now === "function" ? options.now() : options.now;
  const now = requestedNow instanceof Date && Number.isFinite(requestedNow.getTime())
    ? requestedNow
    : new Date();
  const currentMonthName = monthKey(now);
  const usageProfile = normalizedUsageProfile(report);
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const currentMonthEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const currentMonthStats = serializableStats(report.monthly?.[currentMonthName] || { costUsd: 0 });
  const monthlyCostLimitUsd = usageProfile.mode === "api" && Number.isFinite(report.monthlyCostLimitUsd) && report.monthlyCostLimitUsd > 0
    ? report.monthlyCostLimitUsd
    : null;
  const currentMonthCostUsd = currentMonthStats.costUsd || 0;
  const subscriptionWindows = usageProfile.mode === "subscription" ? subscriptionWindowSummaries(report, now) : [];
  return {
    generatedAt: now.toISOString(),
    usageProfile,
    costSemantics: usageProfile.mode === "subscription" ? "api-equivalent" : "estimated-billed",
    apiEquivalentCostUsd: report.total.costUsd || 0,
    billedCostUsd: usageProfile.mode === "api" ? (report.total.costUsd || 0) : null,
    subscriptionWindows,
    sources: report.sources,
    total: serializableStats(report.total),
    currentMonth: {
      name: currentMonthName,
      through: dateKey(now),
      startAt: currentMonthStart.toISOString(),
      endAt: currentMonthEnd.toISOString(),
      ...currentMonthStats,
      limitUsd: monthlyCostLimitUsd,
      remainingUsd: monthlyCostLimitUsd === null ? null : Math.max(0, monthlyCostLimitUsd - currentMonthCostUsd),
      overageUsd: monthlyCostLimitUsd === null ? null : Math.max(0, currentMonthCostUsd - monthlyCostLimitUsd),
      usedRatio: monthlyCostLimitUsd === null ? null : currentMonthCostUsd / monthlyCostLimitUsd,
    },
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
    recommendations: buildRecommendations(report, { now, usageProfile, subscriptionWindows }),
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
