"use strict";

const {
  AGENT_CLAUDE_CODE,
  AGENT_CODEX,
  UNKNOWN_MODEL,
  dateKey,
  normalizeEffort,
  normalizeModel,
  number,
  weekKey,
} = require("./report-model");
const { normalizeUsage } = require("./usage");

const RESET_AT_JITTER_SECONDS = 60;

function newRateLimitStats(meta = {}) {
  return {
    agent: meta.agent || null,
    periodType: meta.periodType || null,
    period: meta.period || null,
    limitId: meta.limitId || null,
    limitName: meta.limitName || null,
    planType: meta.planType || null,
    kind: meta.kind || null,
    windowMinutes: meta.windowMinutes || null,
    samples: 0,
    increases: 0,
    resets: 0,
    outOfOrder: 0,
    ignoredNonMonotonic: 0,
    reached: 0,
    percentUsedDelta: 0,
    latestUsedPercent: null,
    latestRemainingPercent: null,
    latestAt: null,
    latestResetAt: null,
    activeMs: 0,
    resetGapMs: 0,
    maxResetGapMs: 0,
    byEffort: {},
    byModel: {},
    byModelEffort: {},
  };
}

function newRateLimitAttribution() {
  return {
    samples: 0,
    increases: 0,
    percentUsedDelta: 0,
    activeMs: 0,
    input: 0,
    cacheRead: 0,
    output: 0,
    reasoningOutput: 0,
    costUsd: 0,
    reasoningCostUsd: 0,
  };
}

function rateLimitAttributionBucket(root, key) {
  root[key] ??= newRateLimitAttribution();
  return root[key];
}

function nestedRateLimitAttributionBucket(root, key1, key2) {
  root[key1] ??= {};
  root[key1][key2] ??= newRateLimitAttribution();
  return root[key1][key2];
}

function addRateLimitAttribution(target, deltaPercent, elapsedMs, usage, cost) {
  target.increases += 1;
  target.percentUsedDelta += deltaPercent;
  target.activeMs += Math.max(0, elapsedMs);
  target.input += usage.input;
  target.cacheRead += usage.cacheRead;
  target.output += usage.output;
  target.reasoningOutput += usage.reasoningOutput;
  target.costUsd += cost?.known ? cost.amount : 0;
  target.reasoningCostUsd += cost?.known ? cost.reasoningAmount : 0;
}

function addRateLimitSample(target) {
  target.samples += 1;
}

function rateLimitWindowKey(snapshot, kind, window) {
  const limitId = snapshot.limit_id || "unknown-limit";
  const minutes = window.window_minutes ?? "unknown";
  return `${limitId}:${kind}_${minutes}m`;
}

function sameRateLimitWindow(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return Math.abs(left - right) <= RESET_AT_JITTER_SECONDS;
}

function normalizeAgentType(agent, provider, model) {
  const explicit = String(agent || "").trim().toLowerCase();
  if (explicit) return explicit;
  const normalizedModel = normalizeModel(model);
  if (normalizedModel.startsWith("claude-") || provider === "anthropic") return AGENT_CLAUDE_CODE;
  return AGENT_CODEX;
}

function rateLimitPeriodInfo(sample, periodType) {
  const date = new Date(sample.timestampMs);
  const period = periodType === "daily" ? dateKey(date) : weekKey(date);
  return {
    key: `${sample.agent}/${period}/${sample.key}`,
    period,
  };
}

function touchRateLimitStats(root, key, current, meta) {
  const stats = root[key] ??= newRateLimitStats(meta);
  const modelEffort = nestedRateLimitAttributionBucket(stats.byModelEffort, current.model, current.effort);
  const effortStats = rateLimitAttributionBucket(stats.byEffort, current.effort);
  const modelStats = rateLimitAttributionBucket(stats.byModel, current.model);
  addRateLimitSample(stats);
  addRateLimitSample(effortStats);
  addRateLimitSample(modelStats);
  addRateLimitSample(modelEffort);
  if (current.reached) stats.reached += 1;
  stats.latestUsedPercent = current.usedPercent;
  stats.latestRemainingPercent = Math.max(0, 100 - current.usedPercent);
  stats.latestAt = new Date(current.timestampMs).toISOString();
  stats.latestResetAt = current.resetsAt || null;
  return { stats, effortStats, modelStats, modelEffort };
}

function addRateLimitDelta(buckets, deltaPercent, elapsedMs, current) {
  for (const bucket of buckets) {
    bucket.stats.increases += 1;
    bucket.stats.percentUsedDelta += deltaPercent;
    bucket.stats.activeMs += Math.max(0, elapsedMs);
    addRateLimitAttribution(bucket.effortStats, deltaPercent, elapsedMs, current.usage, current.cost);
    addRateLimitAttribution(bucket.modelStats, deltaPercent, elapsedMs, current.usage, current.cost);
    addRateLimitAttribution(bucket.modelEffort, deltaPercent, elapsedMs, current.usage, current.cost);
  }
}

function addRateLimitSnapshot(report, snapshot, meta) {
  if (!snapshot) return;
  const timestampMs = meta.timestamp.getTime();
  if (!Number.isFinite(timestampMs)) return;
  const agent = normalizeAgentType(meta.agent, meta.provider, meta.model);

  for (const [kind, window] of [["primary", snapshot.primary], ["secondary", snapshot.secondary]]) {
    if (!window) continue;

    const key = rateLimitWindowKey(snapshot, kind, window);
    const sample = {
      key,
      groupKey: `${agent}/${key}`,
      sequence: report._rateLimitSequence++,
      timestampMs,
      windowMeta: {
        limitId: snapshot.limit_id || null,
        limitName: snapshot.limit_name || null,
        planType: snapshot.plan_type || null,
        kind,
        windowMinutes: window.window_minutes || null,
      },
      usedPercent: number(window.used_percent),
      resetsAt: number(window.resets_at),
      reached: Boolean(snapshot.rate_limit_reached_type),
      sourcePath: meta.sourcePath || null,
      lineNo: Number.isFinite(meta.lineNo) ? meta.lineNo : null,
      agent,
      effort: normalizeEffort(meta.effort),
      model: meta.model || UNKNOWN_MODEL,
      usage: normalizeUsage(meta.usage),
      cost: {
        known: Boolean(meta.cost?.known),
        amount: number(meta.cost?.amount),
        reasoningAmount: number(meta.cost?.reasoningAmount),
      },
    };
    if (typeof report._rateLimitSampleSink === "function") {
      report._rateLimitSampleSink(sample);
    } else {
      report._rateLimitSamples.push(sample);
    }
  }
  report._rateLimitFinalized = false;
}

function finalizeRateLimits(report) {
  report.rateLimits = { windows: {}, daily: {}, weekly: {} };
  const groups = new Map();
  for (const sample of report._rateLimitSamples) {
    const groupKey = sample.groupKey || sample.key;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(sample);
  }

  for (const [groupKey, samples] of groups) {
    samples.sort((a, b) => {
      const byTime = a.timestampMs - b.timestampMs;
      if (byTime !== 0) return byTime;
      return a.sequence - b.sequence;
    });

    let previous = null;
    for (const current of samples) {
      const daily = rateLimitPeriodInfo(current, "daily");
      const weekly = rateLimitPeriodInfo(current, "weekly");
      const buckets = [
        touchRateLimitStats(report.rateLimits.windows, groupKey, current, {
          ...current.windowMeta,
          agent: current.agent,
        }),
        touchRateLimitStats(report.rateLimits.daily, daily.key, current, {
          ...current.windowMeta,
          agent: current.agent,
          periodType: "daily",
          period: daily.period,
        }),
        touchRateLimitStats(report.rateLimits.weekly, weekly.key, current, {
          ...current.windowMeta,
          agent: current.agent,
          periodType: "weekly",
          period: weekly.period,
        }),
      ];

      if (!previous) {
        previous = current;
        continue;
      }

      if (current.timestampMs < previous.timestampMs) {
        for (const bucket of buckets) bucket.stats.outOfOrder += 1;
        continue;
      }

      const sameWindow = sameRateLimitWindow(current.resetsAt, previous.resetsAt);
      if (sameWindow && current.resetsAt !== 0 && current.usedPercent < previous.usedPercent) {
        for (const bucket of buckets) {
          bucket.stats.ignoredNonMonotonic += 1;
          bucket.stats.latestUsedPercent = previous.usedPercent;
          bucket.stats.latestRemainingPercent = Math.max(0, 100 - previous.usedPercent);
          bucket.stats.latestAt = new Date(previous.timestampMs).toISOString();
          bucket.stats.latestResetAt = previous.resetsAt || null;
        }
        continue;
      }

      const elapsedMs = current.timestampMs - previous.timestampMs;
      if (!sameWindow || current.usedPercent < previous.usedPercent) {
        for (const bucket of buckets) {
          bucket.stats.resets += 1;
        }
        if (elapsedMs > 0) {
          for (const bucket of buckets) {
            bucket.stats.resetGapMs += elapsedMs;
            bucket.stats.maxResetGapMs = Math.max(bucket.stats.maxResetGapMs, elapsedMs);
          }
        }
        previous = current;
        continue;
      }

      const deltaPercent = current.usedPercent - previous.usedPercent;
      if (deltaPercent > 0) {
        addRateLimitDelta(buckets, deltaPercent, elapsedMs, current);
      }
      previous = current;
    }
  }
  report._rateLimitFinalized = true;
}

module.exports = {
  RESET_AT_JITTER_SECONDS,
  addRateLimitAttribution,
  addRateLimitDelta,
  addRateLimitSample,
  addRateLimitSnapshot,
  finalizeRateLimits,
  nestedRateLimitAttributionBucket,
  newRateLimitAttribution,
  newRateLimitStats,
  normalizeAgentType,
  rateLimitAttributionBucket,
  rateLimitPeriodInfo,
  rateLimitWindowKey,
  sameRateLimitWindow,
  touchRateLimitStats,
};
