"use strict";

const fsp = require("node:fs/promises");
const Path = require("node:path");
const { UNKNOWN_EFFORT, newStats } = require("../core/report-model");
const { PRICING_SOURCES } = require("../core/pricing");
const { finalizeRateLimits } = require("../core/rate-limits");
const { emitSyncProgress } = require("../core/sync-progress");

function sortedEntries(data) {
  return Object.entries(data).sort((a, b) => {
    const byCost = b[1].costUsd - a[1].costUsd;
    if (byCost !== 0) return byCost;
    return b[1].input + b[1].cacheRead + b[1].output - (a[1].input + a[1].cacheRead + a[1].output);
  });
}

function formatInt(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatUsd(value) {
  return `$${value.toFixed(4)}`;
}

function formatRatio(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)}x`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 2;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function formatDurationMs(ms) {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function formatHours(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0.00h";
  return `${(ms / 3_600_000).toFixed(2)}h`;
}

function percentPerHour(percent, ms) {
  const hours = ms / 3_600_000;
  return hours > 0 ? percent / hours : Number.NaN;
}

function formatPercentPerHour(percent, ms) {
  const value = percentPerHour(percent, ms);
  return Number.isFinite(value) ? `${value.toFixed(2)}pp/h` : "n/a";
}

function formatStatsLine(name, stats) {
  const unpriced = stats.unpricedRequests ? `, unpriced=${stats.unpricedRequests}` : "";
  const reasoning = stats.reasoningOutput
    ? `, reasoning_output=${formatInt(stats.reasoningOutput)}, reasoning_cost=${formatUsd(stats.reasoningCostUsd)}, reasoning_cost_share=${formatPercent(stats.reasoningCostUsd / stats.costUsd)}`
    : "";
  return `${name}: requests=${formatInt(stats.requests)}, input=${formatInt(stats.input)}, cache_create_5m=${formatInt(stats.cacheCreate5m)}, cache_create_30m=${formatInt(stats.cacheCreate30m)}, cache_create_1h=${formatInt(stats.cacheCreate1h)}, cache_read=${formatInt(stats.cacheRead)}, output=${formatInt(stats.output)}${reasoning}, cost=${formatUsd(stats.costUsd)}, cost_by_type=${formatCostBreakdown(stats.costsUsd)}${unpriced}`;
}

function formatCostBreakdown(costs) {
  return `{input:${formatUsd(costs.input)}, cache_create_5m:${formatUsd(costs.cacheCreate5m)}, cache_create_30m:${formatUsd(costs.cacheCreate30m)}, cache_create_1h:${formatUsd(costs.cacheCreate1h)}, cache_read:${formatUsd(costs.cacheRead)}, output:${formatUsd(costs.output)}}`;
}

function logProgress(options, message) {
  if (!options.progress) return;
  console.log(message);
}

function startSession(report, options, meta) {
  const session = {
    ...meta,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    lines: 0,
    records: 0,
    parseErrors: 0,
    tokenCountSnapshots: 0,
    skippedTokenCountSnapshots: 0,
    stats: newStats(),
  };
  report.sessions.push(session);
  emitSyncProgress(options, { phase: "processing", currentSource: meta.path });

  const size = meta.sizeBytes == null ? "unknown" : formatBytes(meta.sizeBytes);
  const compressed = meta.compressedSizeBytes == null ? "" : ` compressed=${formatBytes(meta.compressedSizeBytes)}`;
  logProgress(options, `[start] ${meta.path} size=${size}${compressed}`);
  session._startedNs = process.hrtime.bigint();
  return session;
}

function finishSession(session, options) {
  const elapsedNs = process.hrtime.bigint() - session._startedNs;
  delete session._startedNs;
  session.finishedAt = new Date().toISOString();
  session.durationMs = Number(elapsedNs) / 1_000_000;

  const codexSnapshots = session.tokenCountSnapshots
    ? `, token_count_snapshots=${formatInt(session.tokenCountSnapshots)}, skipped_snapshots=${formatInt(session.skippedTokenCountSnapshots)}`
    : "";
  logProgress(options, `[done] ${session.path} duration=${formatDurationMs(session.durationMs)}, lines=${formatInt(session.lines)}, records=${formatInt(session.records)}, messages=${formatInt(session.stats.requests)}${codexSnapshots}, parse_errors=${formatInt(session.parseErrors)}, ${formatStatsLine("session", session.stats)}`);
  emitSyncProgress(options, {
    phase: "processing",
    currentSource: null,
    sourceCompleted: true,
    bytesProcessed: session.sizeBytes || 0,
  });
}

function printSection(title, data, top) {
  const lines = [`${title}:`];
  const entries = sortedEntries(data).slice(0, top);
  if (entries.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const [name, stats] of entries) {
    lines.push(`  ${formatStatsLine(name, stats)}`);
  }
  return lines.join("\n");
}

function effortRank(name) {
  const order = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra", UNKNOWN_EFFORT];
  const index = order.indexOf(name);
  return index === -1 ? order.length : index;
}

function sortedEffortEntries(data) {
  return Object.entries(data).sort((a, b) => {
    const byRank = effortRank(a[0]) - effortRank(b[0]);
    if (byRank !== 0) return byRank;
    return b[1].costUsd - a[1].costUsd;
  });
}

function averageCost(stats) {
  return stats.requests ? stats.costUsd / stats.requests : Number.NaN;
}

function printEffortSection(title, data, top) {
  const lines = [`${title}:`];
  const entries = sortedEffortEntries(data).slice(0, top);
  if (entries.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  const baseline = entries.find(([name, stats]) => name !== UNKNOWN_EFFORT && stats.requests > 0) || entries[0];
  const baselineName = baseline?.[0] || UNKNOWN_EFFORT;
  const baselineAverage = averageCost(baseline?.[1] || newStats());

  for (const [name, stats] of entries) {
    const avg = averageCost(stats);
    const ratio = Number.isFinite(avg) && Number.isFinite(baselineAverage) && baselineAverage > 0
      ? avg / baselineAverage
      : Number.NaN;
    lines.push(`  ${formatStatsLine(name, stats)}, avg_cost=${formatUsd(avg)}, vs_${baselineName}=${formatRatio(ratio)}`);
  }
  return lines.join("\n");
}

function flattenNestedStats(data) {
  const flattened = {};
  for (const [outer, inner] of Object.entries(data)) {
    for (const [innerName, stats] of Object.entries(inner)) {
      flattened[`${outer} / ${innerName}`] = stats;
    }
  }
  return flattened;
}

function sortedRateLimitEntries(data) {
  return Object.entries(data).sort((a, b) => {
    const byDelta = b[1].percentUsedDelta - a[1].percentUsedDelta;
    if (byDelta !== 0) return byDelta;
    return b[1].samples - a[1].samples;
  });
}

function formatRateLimitLine(name, stats) {
  const ignored = stats.ignoredNonMonotonic ? `, ignored_nonmonotonic=${formatInt(stats.ignoredNonMonotonic)}` : "";
  const latest = stats.latestUsedPercent === null ? "" : `, latest_used=${stats.latestUsedPercent.toFixed(2)}%, latest_remaining=${stats.latestRemainingPercent.toFixed(2)}%`;
  return `${name}: samples=${formatInt(stats.samples)}, increases=${formatInt(stats.increases)}, resets=${formatInt(stats.resets)}${ignored}, used_delta=${stats.percentUsedDelta.toFixed(2)}pp${latest}, active=${formatHours(stats.activeMs)}, used_per_hour=${formatPercentPerHour(stats.percentUsedDelta, stats.activeMs)}, reset_gap=${formatHours(stats.resetGapMs)}, max_reset_gap=${formatHours(stats.maxResetGapMs)}`;
}

function formatRateLimitAttributionLine(name, stats) {
  return `${name}: samples=${formatInt(stats.samples)}, increases=${formatInt(stats.increases)}, used_delta=${stats.percentUsedDelta.toFixed(2)}pp, active=${formatHours(stats.activeMs)}, used_per_hour=${formatPercentPerHour(stats.percentUsedDelta, stats.activeMs)}, input=${formatInt(stats.input)}, cache_read=${formatInt(stats.cacheRead)}, output=${formatInt(stats.output)}, reasoning_output=${formatInt(stats.reasoningOutput)}, cost=${formatUsd(stats.costUsd)}`;
}

function formatRateLimitEffortSummary(stats, top) {
  const efforts = sortedRateLimitEntries(stats.byEffort).slice(0, Math.min(top, 4));
  if (efforts.length === 0) return "";
  return `, efforts={${efforts.map(([effort, effortStats]) => `${effort}:${effortStats.percentUsedDelta.toFixed(2)}pp`).join(", ")}}`;
}

function printRateLimitSection(report, top) {
  const lines = ["Rate limits:"];
  const overall = sortedRateLimitEntries(report.rateLimits.windows).slice(0, top);
  if (overall.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }

  lines.push("  Overall:");
  for (const [name, stats] of overall) {
    lines.push(`    ${formatRateLimitLine(name, stats)}`);
    const efforts = sortedRateLimitEntries(stats.byEffort).slice(0, top);
    for (const [effort, effortStats] of efforts) {
      lines.push(`      effort ${formatRateLimitAttributionLine(effort, effortStats)}`);
    }
    const modelEfforts = sortedRateLimitEntries(flattenNestedStats(stats.byModelEffort)).slice(0, top);
    for (const [modelEffort, modelEffortStats] of modelEfforts) {
      lines.push(`      model_effort ${formatRateLimitAttributionLine(modelEffort, modelEffortStats)}`);
    }
  }

  for (const [title, data] of [["By day", report.rateLimits.daily], ["By week", report.rateLimits.weekly]]) {
    lines.push(`  ${title}:`);
    const entries = sortedRateLimitEntries(data).slice(0, top);
    if (entries.length === 0) {
      lines.push("    (none)");
      continue;
    }
    for (const [name, stats] of entries) {
      lines.push(`    ${formatRateLimitLine(name, stats)}${formatRateLimitEffortSummary(stats, top)}`);
    }
  }
  return lines.join("\n");
}

function renderTextReport(report, options) {
  const lines = [];
  lines.push("Tokenomics Viewer");
  lines.push(`Sources: files=${formatInt(report.sources.files)}, zip_files=${formatInt(report.sources.zipFiles)}, zip_entries=${formatInt(report.sources.zipEntries)}, skipped=${formatInt(report.sources.skippedFiles)}, token_count_snapshots=${formatInt(report.sources.tokenCountSnapshots)}, skipped_token_count_snapshots=${formatInt(report.sources.skippedTokenCountSnapshots)}, parse_errors=${formatInt(report.sources.parseErrors)}`);
  lines.push(`Pricing sources: OpenAI=${PRICING_SOURCES.openai}; OpenAI GPT-5.6=${PRICING_SOURCES.openaiGpt56}; OpenAI models=${PRICING_SOURCES.openaiGpt5}; OpenAI Codex=${PRICING_SOURCES.openaiCodex}; Anthropic=${PRICING_SOURCES.anthropic}`);
  lines.push(`OpenAI context pricing mode: ${options.openaiContext}`);
  lines.push(formatStatsLine("Total", report.total));
  lines.push(printSection("By provider", report.providers, options.top));
  lines.push(printSection("By model", report.models, options.top));
  lines.push(printEffortSection("By effort", report.efforts, options.top));
  lines.push(printSection("By model/effort", flattenNestedStats(report.modelEfforts), options.top));
  lines.push(printRateLimitSection(report, options.top));
  lines.push(printSection("By project", report.projects, options.top));
  lines.push(printSection("Daily", report.daily, options.top));

  const sessions = report.sessions
    .slice()
    .sort((a, b) => b.stats.costUsd - a.stats.costUsd)
    .slice(0, options.top);
  lines.push("Sessions:");
  if (sessions.length === 0) {
    lines.push("  (none)");
  } else {
    for (const session of sessions) {
      const size = session.sizeBytes == null ? "unknown" : formatBytes(session.sizeBytes);
      const codexSnapshots = session.tokenCountSnapshots
        ? `, token_count_snapshots=${formatInt(session.tokenCountSnapshots)}, skipped_snapshots=${formatInt(session.skippedTokenCountSnapshots)}`
        : "";
      lines.push(`  ${session.path}: size=${size}, duration=${formatDurationMs(session.durationMs)}, lines=${formatInt(session.lines)}, records=${formatInt(session.records)}, messages=${formatInt(session.stats.requests)}${codexSnapshots}, parse_errors=${formatInt(session.parseErrors)}, ${formatStatsLine("session", session.stats)}`);
    }
  }

  const unpriced = Object.values(report.unpricedModels).sort((a, b) => b.requests - a.requests);
  if (unpriced.length > 0) {
    lines.push("Unpriced models:");
    for (const item of unpriced.slice(0, options.top)) {
      lines.push(`  ${item.provider}/${item.model}: requests=${formatInt(item.requests)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderReport(report, options) {
  if (!report._rateLimitFinalized) finalizeRateLimits(report);
  if (options.format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }
  return renderTextReport(report, options);
}

async function writeReport(report, options) {
  const rendered = renderReport(report, options);
  if (options.output) {
    await fsp.mkdir(Path.dirname(options.output), { recursive: true });
    await fsp.writeFile(options.output, rendered);
    logProgress(options, `[report] ${options.output} format=${options.format} size=${formatBytes(Buffer.byteLength(rendered))}`);
  } else {
    process.stdout.write(rendered);
  }
}

module.exports = {
  finishSession,
  formatBytes,
  formatInt,
  logProgress,
  renderReport,
  startSession,
  writeReport,
};
