"use strict";

const UNKNOWN_PROJECT = "(unknown project)";
const UNKNOWN_MODEL = "(unknown model)";
const UNKNOWN_EFFORT = "<unknown>";
const AGENT_CODEX = "codex";
const AGENT_CLAUDE_CODE = "claude-code";
const MAX_VALID_OUTPUT_CHARS_PER_TOKEN = 10;

function newStats() {
  return {
    requests: 0,
    input: 0,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    output: 0,
    reasoningOutput: 0,
    costUsd: 0,
    reasoningCostUsd: 0,
    costsUsd: newCostBreakdown(),
    pricedRequests: 0,
    unpricedRequests: 0,
    pricedInput: 0,
    pricedCacheCreate5m: 0,
    pricedCacheCreate30m: 0,
    pricedCacheCreate1h: 0,
    pricedCacheRead: 0,
    pricedOutput: 0,
    pricedReasoningOutput: 0,
    visibleInputChars: 0,
    visibleOutputChars: 0,
    visibleTotalChars: 0,
    visibleCharTokenSamples: 0,
    visibleCharsPerTokenSum: 0,
    visibleCharsPerTokenMin: null,
    visibleCharsPerTokenMax: null,
    visibleOutputTextChars: 0,
    visibleOutputTextTokens: 0,
    outputCharTokenSamples: 0,
    outputCharsPerTokenSum: 0,
    outputCharsPerTokenMin: null,
    outputCharsPerTokenMax: null,
    outputCharsPerTokenP10: null,
    outputCharsPerTokenP99: null,
    outputCharTokenOutliers: 0,
  };
}

function newCostBreakdown() {
  return {
    input: 0,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0,
    output: 0,
  };
}

function newVisibleChars() {
  return {
    input: 0,
    output: 0,
  };
}

function newReport() {
  const report = {
    total: newStats(),
    monthlyCostLimitUsd: null,
    quarterHourly: {},
    quarterHourlyProviderModels: {},
    daily: {},
    weekly: {},
    monthly: {},
    yearly: {},
    providers: {},
    models: {},
    providerModels: {},
    projects: {},
    projectQuarterHourly: {},
    projectQuarterHourlyProviderModels: {},
    projectDaily: {},
    projectModels: {},
    projectProviderModels: {},
    efforts: {},
    modelEfforts: {},
    providerModelEffortDaily: {},
    rateLimits: {
      windows: {},
      daily: {},
      weekly: {},
    },
    unpricedModels: {},
    sessions: [],
    sources: {
      files: 0,
      zipFiles: 0,
      zipEntries: 0,
      parseErrors: 0,
      skippedFiles: 0,
      tokenCountSnapshots: 0,
      skippedTokenCountSnapshots: 0,
    },
  };
  Object.defineProperties(report, {
    _rateLimitSamples: {
      value: [],
      enumerable: false,
    },
    _rateLimitSequence: {
      value: 0,
      enumerable: false,
      writable: true,
    },
    _rateLimitFinalized: {
      value: false,
      enumerable: false,
      writable: true,
    },
    _usageEvents: {
      value: [],
      enumerable: false,
    },
    _usageEventSink: {
      value: null,
      enumerable: false,
      writable: true,
    },
    _outputCharMetrics: {
      value: [],
      enumerable: false,
    },
    _outputCharMetricSink: {
      value: null,
      enumerable: false,
      writable: true,
    },
    _rateLimitSampleSink: {
      value: null,
      enumerable: false,
      writable: true,
    },
  });
  return report;
}

function number(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function addToStats(target, usage, cost, visibleChars = {}) {
  target.requests += 1;
  target.input += usage.input;
  target.cacheCreate5m += usage.cacheCreate5m;
  target.cacheCreate30m += usage.cacheCreate30m;
  target.cacheCreate1h += usage.cacheCreate1h;
  target.cacheRead += usage.cacheRead;
  target.output += usage.output;
  target.reasoningOutput += usage.reasoningOutput;
  target.costUsd += cost.known ? cost.amount : 0;
  target.reasoningCostUsd += cost.known ? cost.reasoningAmount : 0;
  addCostBreakdown(target.costsUsd, cost.breakdown);
  target.pricedRequests += cost.known ? 1 : 0;
  target.unpricedRequests += cost.known ? 0 : 1;
  if (cost.known) {
    target.pricedInput += usage.input;
    target.pricedCacheCreate5m += usage.cacheCreate5m;
    target.pricedCacheCreate30m += usage.cacheCreate30m;
    target.pricedCacheCreate1h += usage.cacheCreate1h;
    target.pricedCacheRead += usage.cacheRead;
    target.pricedOutput += usage.output;
    target.pricedReasoningOutput += usage.reasoningOutput;
  }
  addVisibleCharStats(target, normalizeVisibleChars(visibleChars, usage));
}

function addCostBreakdown(target, source = newCostBreakdown()) {
  target.input += number(source.input);
  target.cacheCreate5m += number(source.cacheCreate5m);
  target.cacheCreate30m += number(source.cacheCreate30m);
  target.cacheCreate1h += number(source.cacheCreate1h);
  target.cacheRead += number(source.cacheRead);
  target.output += number(source.output);
}

function usageTextTokenTotal(usage) {
  return number(usage.input) + number(usage.cacheCreate5m) + number(usage.cacheCreate30m) + number(usage.cacheCreate1h) + number(usage.cacheRead) + number(usage.output);
}

function normalizeVisibleChars(chars = {}, usage = {}) {
  const source = chars || {};
  const input = number(source.input);
  const output = number(source.output);
  const total = number(source.total) || input + output;
  const denominator = usageTextTokenTotal(usage || {});
  const charsPerToken = number(source.charsPerToken) || (total > 0 && denominator > 0 ? total / denominator : 0);
  return { input, output, total, charsPerToken };
}

function addVisibleCharStats(target, visibleChars) {
  const chars = normalizeVisibleChars(visibleChars);
  target.visibleInputChars += chars.input;
  target.visibleOutputChars += chars.output;
  target.visibleTotalChars += chars.total;
  if (chars.charsPerToken > 0) {
    target.visibleCharTokenSamples += 1;
    target.visibleCharsPerTokenSum += chars.charsPerToken;
    target.visibleCharsPerTokenMin = target.visibleCharsPerTokenMin === null
      ? chars.charsPerToken
      : Math.min(target.visibleCharsPerTokenMin, chars.charsPerToken);
    target.visibleCharsPerTokenMax = target.visibleCharsPerTokenMax === null
      ? chars.charsPerToken
      : Math.max(target.visibleCharsPerTokenMax, chars.charsPerToken);
  }
}

function outputTextTokens(usage = {}) {
  const source = usage || {};
  return Math.max(0, number(source.output) - number(source.reasoningOutput));
}

function normalizeOutputCharTokenMetric(metric = {}) {
  const source = metric || {};
  const chars = number(source.visibleOutputChars ?? source.chars);
  const tokens = number(source.visibleOutputTokens ?? source.tokens);
  const charsPerToken = number(source.charsPerToken) || (chars > 0 && tokens > 0 ? chars / tokens : 0);
  return { chars, tokens, charsPerToken };
}

function addOutputCharTokenStats(target, metric) {
  const sample = normalizeOutputCharTokenMetric(metric);
  if (sample.charsPerToken > 0) {
    if (sample.charsPerToken > MAX_VALID_OUTPUT_CHARS_PER_TOKEN) {
      target.outputCharTokenOutliers += 1;
      return;
    }
    target.visibleOutputTextChars += sample.chars;
    target.visibleOutputTextTokens += sample.tokens;
    target.outputCharTokenSamples += 1;
    target.outputCharsPerTokenSum += sample.charsPerToken;
    target.outputCharsPerTokenMin = target.outputCharsPerTokenMin === null
      ? sample.charsPerToken
      : Math.min(target.outputCharsPerTokenMin, sample.charsPerToken);
    target.outputCharsPerTokenMax = target.outputCharsPerTokenMax === null
      ? sample.charsPerToken
      : Math.max(target.outputCharsPerTokenMax, sample.charsPerToken);
  }
}

function addOutputCharTokenMetric(report, record) {
  const source = record || {};
  const timestamp = isValidDate(source.timestamp) ? source.timestamp : new Date(NaN);
  const project = source.project || UNKNOWN_PROJECT;
  const model = source.model || UNKNOWN_MODEL;
  const provider = source.provider || inferProvider(model);
  const effort = normalizeEffort(source.effort);
  const metric = normalizeOutputCharTokenMetric(source);

  addOutputCharTokenStats(report.total, metric);
  addOutputCharTokenStats(bucket(report.daily, dateKey(timestamp)), metric);
  addOutputCharTokenStats(bucket(report.weekly, weekKey(timestamp)), metric);
  addOutputCharTokenStats(bucket(report.monthly, monthKey(timestamp)), metric);
  addOutputCharTokenStats(bucket(report.yearly, yearKey(timestamp)), metric);
  addOutputCharTokenStats(bucket(report.providers, provider), metric);
  addOutputCharTokenStats(bucket(report.models, model), metric);
  addOutputCharTokenStats(bucket(report.providerModels, `${provider}/${model}`), metric);
  addOutputCharTokenStats(bucket(report.projects, project), metric);
  addOutputCharTokenStats(nestedBucket(report.projectDaily, project, dateKey(timestamp)), metric);
  addOutputCharTokenStats(nestedBucket(report.projectModels, project, model), metric);
  report.projectProviderModels[project] ??= {};
  addOutputCharTokenStats(nestedBucket(report.projectProviderModels[project], provider, model), metric);
  addOutputCharTokenStats(bucket(report.efforts, effort), metric);
  addOutputCharTokenStats(nestedBucket(report.modelEfforts, model, effort), metric);

  const event = {
    sourcePath: source.sourcePath || null,
    turnId: source.turnId || null,
    timestamp: isValidDate(timestamp) ? timestamp.toISOString() : null,
    provider,
    model,
    project,
    effort,
    visibleOutputChars: metric.chars,
    visibleOutputTokens: metric.tokens,
    charsPerToken: metric.charsPerToken,
  };
  if (typeof report._outputCharMetricSink === "function") {
    report._outputCharMetricSink(event);
  } else {
    report._outputCharMetrics.push(event);
  }

  return event;
}

function bucket(root, key) {
  root[key] ??= newStats();
  return root[key];
}

function nestedBucket(root, key1, key2) {
  root[key1] ??= {};
  root[key1][key2] ??= newStats();
  return root[key1][key2];
}

function providerModelEffortDailyBucket(report, provider, model, effort, day) {
  report.providerModelEffortDaily[provider] ??= {};
  report.providerModelEffortDaily[provider][model] ??= {};
  return nestedBucket(report.providerModelEffortDaily[provider][model], effort, day);
}

function isValidDate(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function dateKey(date) {
  if (!isValidDate(date)) return "unknown-date";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function quarterHourKey(date) {
  if (!isValidDate(date)) return null;
  const bucketMs = Math.floor(date.getTime() / 900_000) * 900_000;
  return new Date(bucketMs).toISOString().slice(0, 16) + "Z";
}

function monthKey(date) {
  if (!isValidDate(date)) return "unknown-month";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function yearKey(date) {
  if (!isValidDate(date)) return "unknown-year";
  return String(date.getFullYear());
}

function weekKey(date) {
  if (!isValidDate(date)) return "unknown-week";
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - yearStart) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${pad2(week)}`;
}

function inferProvider(model, fallback) {
  const value = (model || "").toLowerCase();
  if (value.startsWith("claude-")) return "anthropic";
  if (value.startsWith("gpt-") || value.startsWith("o") || value === "chat-latest") return "openai";
  return fallback || "unknown";
}

function normalizeModel(model) {
  return String(model || UNKNOWN_MODEL).trim().toLowerCase();
}

function normalizeEffort(effort) {
  if (typeof effort !== "string" || effort.trim() === "") return UNKNOWN_EFFORT;
  return effort.trim().toLowerCase();
}

module.exports = {
  AGENT_CLAUDE_CODE,
  AGENT_CODEX,
  MAX_VALID_OUTPUT_CHARS_PER_TOKEN,
  UNKNOWN_EFFORT,
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
  addCostBreakdown,
  addOutputCharTokenMetric,
  addOutputCharTokenStats,
  addToStats,
  addVisibleCharStats,
  bucket,
  dateKey,
  inferProvider,
  isValidDate,
  monthKey,
  nestedBucket,
  newCostBreakdown,
  newReport,
  newStats,
  newVisibleChars,
  normalizeEffort,
  normalizeModel,
  normalizeOutputCharTokenMetric,
  normalizeVisibleChars,
  number,
  outputTextTokens,
  pad2,
  providerModelEffortDailyBucket,
  quarterHourKey,
  weekKey,
  yearKey,
};
