#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const Path = require("node:path");
const readline = require("node:readline");
const { DatabaseSync } = require("node:sqlite");
const { Readable } = require("node:stream");
const { URL } = require("node:url");
const zlib = require("node:zlib");
const dashboard = require("./lib/dashboard");

const TOKENS_PER_PRICE_UNIT = 1_000_000;
const UNKNOWN_PROJECT = "(unknown project)";
const UNKNOWN_MODEL = "(unknown model)";
const UNKNOWN_EFFORT = "<unknown>";
const AGENT_CODEX = "codex";
const AGENT_CLAUDE_CODE = "claude-code";
const MAX_CENTRAL_DIRECTORY_BYTES = 256 * 1024 * 1024;
const DEFAULT_DB_FILENAME = "tokenomics.sqlite";
const DEFAULT_DB_ENGINE = "sqlite";
const DEFAULT_CLICKHOUSE_URL = "http://127.0.0.1:8123";
const DEFAULT_CLICKHOUSE_DATABASE = "tokenomics";
const DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS = 100_000;
const DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_VALID_OUTPUT_CHARS_PER_TOKEN = 10;

const PRICING_SOURCES = {
  openai: "https://developers.openai.com/api/docs/pricing",
  openaiGpt56: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  openaiGpt5: "https://developers.openai.com/api/docs/models/gpt-5",
  openaiGpt51: "https://developers.openai.com/api/docs/models/gpt-5.1",
  openaiCodex: "https://developers.openai.com/api/docs/models/gpt-5-codex",
  openaiCodexMini: "https://developers.openai.com/api/docs/models/codex-mini-latest",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
};

// Prices are USD per 1M tokens, copied from the official pricing pages above.
const PRICING = {
  openai: {
    models: {
      "gpt-5.5": {
        short: { input: 5.00, cachedInput: 0.50, output: 30.00 },
        long: { input: 10.00, cachedInput: 1.00, output: 45.00 },
      },
      "gpt-5.6-sol": {
        short: { input: 5.00, cacheCreate30m: 6.25, cachedInput: 0.50, output: 30.00 },
        long: { input: 10.00, cacheCreate30m: 12.50, cachedInput: 1.00, output: 45.00 },
      },
      "gpt-5.6-terra": {
        short: { input: 2.50, cacheCreate30m: 3.125, cachedInput: 0.25, output: 15.00 },
        long: { input: 5.00, cacheCreate30m: 6.25, cachedInput: 0.50, output: 22.50 },
      },
      "gpt-5.6-luna": {
        short: { input: 1.00, cacheCreate30m: 1.25, cachedInput: 0.10, output: 6.00 },
        long: { input: 2.00, cacheCreate30m: 2.50, cachedInput: 0.20, output: 9.00 },
      },
      "gpt-5.5-pro": {
        short: { input: 30.00, cachedInput: null, output: 180.00 },
        long: { input: 60.00, cachedInput: null, output: 270.00 },
      },
      "gpt-5.4": {
        short: { input: 2.50, cachedInput: 0.25, output: 15.00 },
        long: { input: 5.00, cachedInput: 0.50, output: 22.50 },
      },
      "gpt-5.4-mini": {
        short: { input: 0.75, cachedInput: 0.075, output: 4.50 },
      },
      "gpt-5.4-nano": {
        short: { input: 0.20, cachedInput: 0.02, output: 1.25 },
      },
      "gpt-5.4-pro": {
        short: { input: 30.00, cachedInput: null, output: 180.00 },
        long: { input: 60.00, cachedInput: null, output: 270.00 },
      },
      "gpt-5.2": {
        short: { input: 1.75, cachedInput: 0.175, output: 14.00 },
      },
      "gpt-5.1": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5.1-chat-latest": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5-chat-latest": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5-mini": {
        short: { input: 0.25, cachedInput: 0.025, output: 2.00 },
      },
      "gpt-5-nano": {
        short: { input: 0.05, cachedInput: 0.005, output: 0.40 },
      },
      "gpt-5.3-codex": {
        short: { input: 1.75, cachedInput: 0.175, output: 14.00 },
      },
      "gpt-5.2-codex": {
        short: { input: 1.75, cachedInput: 0.175, output: 14.00 },
      },
      "gpt-5.1-codex": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5.1-codex-max": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5-codex": {
        short: { input: 1.25, cachedInput: 0.125, output: 10.00 },
      },
      "gpt-5.1-codex-mini": {
        short: { input: 0.25, cachedInput: 0.025, output: 2.00 },
      },
      "gpt-5-codex-mini": {
        short: { input: 0.25, cachedInput: 0.025, output: 2.00 },
      },
      "codex-mini-latest": {
        short: { input: 1.50, cachedInput: 0.375, output: 6.00 },
      },
      "chat-latest": {
        short: { input: 5.00, cachedInput: 0.50, output: 30.00 },
      },
    },
  },
  anthropic: {
    models: {
      "claude-fable-5": { input: 10.00, cacheCreate5m: 12.50, cacheCreate1h: 20.00, cacheRead: 1.00, output: 50.00 },
      "claude-mythos-5": { input: 10.00, cacheCreate5m: 12.50, cacheCreate1h: 20.00, cacheRead: 1.00, output: 50.00 },
      "claude-opus-4-8": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-7": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-6": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-5": { input: 5.00, cacheCreate5m: 6.25, cacheCreate1h: 10.00, cacheRead: 0.50, output: 25.00 },
      "claude-opus-4-1": { input: 15.00, cacheCreate5m: 18.75, cacheCreate1h: 30.00, cacheRead: 1.50, output: 75.00 },
      "claude-opus-4": { input: 15.00, cacheCreate5m: 18.75, cacheCreate1h: 30.00, cacheRead: 1.50, output: 75.00 },
      "claude-sonnet-5": [
        {
          until: "2026-08-31T23:59:59.999Z",
          prices: { input: 2.00, cacheCreate5m: 2.50, cacheCreate1h: 4.00, cacheRead: 0.20, output: 10.00 },
        },
        {
          from: "2026-09-01T00:00:00.000Z",
          prices: { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
        },
      ],
      "claude-sonnet-4-6": { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
      "claude-sonnet-4-5": { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
      "claude-sonnet-4": { input: 3.00, cacheCreate5m: 3.75, cacheCreate1h: 6.00, cacheRead: 0.30, output: 15.00 },
      "claude-haiku-4-5": { input: 1.00, cacheCreate5m: 1.25, cacheCreate1h: 2.00, cacheRead: 0.10, output: 5.00 },
      "claude-haiku-3-5": { input: 0.80, cacheCreate5m: 1.00, cacheCreate1h: 1.60, cacheRead: 0.08, output: 4.00 },
    },
  },
};

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
    daily: {},
    weekly: {},
    monthly: {},
    yearly: {},
    providers: {},
    models: {},
    providerModels: {},
    projects: {},
    projectDaily: {},
    projectModels: {},
    efforts: {},
    modelEfforts: {},
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

function parseByteSize(value, flagName) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d+(?:\.\d+)?)([kmgt]?i?b?)?$/i);
  if (!match) throw new Error(`${flagName} must be a byte size, for example 33554432 or 32MiB`);

  const amount = Number(match[1]);
  const suffix = (match[2] || "").toLowerCase();
  const multipliers = {
    "": 1,
    b: 1,
    k: 1024,
    kb: 1024,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
    gib: 1024 ** 3,
    t: 1024 ** 4,
    tb: 1024 ** 4,
    tib: 1024 ** 4,
  };
  const bytes = Math.floor(amount * multipliers[suffix]);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`${flagName} must be a positive byte size`);
  }
  return bytes;
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
  const input = number(chars.input);
  const output = number(chars.output);
  const total = number(chars.total) || input + output;
  const denominator = usageTextTokenTotal(usage);
  const charsPerToken = number(chars.charsPerToken) || (total > 0 && denominator > 0 ? total / denominator : 0);
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
  return Math.max(0, number(usage.output) - number(usage.reasoningOutput));
}

function normalizeOutputCharTokenMetric(metric = {}) {
  const chars = number(metric.visibleOutputChars ?? metric.chars);
  const tokens = number(metric.visibleOutputTokens ?? metric.tokens);
  const charsPerToken = number(metric.charsPerToken) || (chars > 0 && tokens > 0 ? chars / tokens : 0);
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
  const timestamp = isValidDate(record.timestamp) ? record.timestamp : new Date(NaN);
  const project = record.project || UNKNOWN_PROJECT;
  const model = record.model || UNKNOWN_MODEL;
  const provider = record.provider || inferProvider(model);
  const effort = normalizeEffort(record.effort);
  const metric = normalizeOutputCharTokenMetric(record);

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
  addOutputCharTokenStats(bucket(report.efforts, effort), metric);
  addOutputCharTokenStats(nestedBucket(report.modelEfforts, model, effort), metric);

  const event = {
    sourcePath: record.sourcePath || null,
    turnId: record.turnId || null,
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

      const sameWindow = current.resetsAt === previous.resetsAt;
      if (sameWindow && current.resetsAt !== 0 && current.usedPercent < previous.usedPercent) {
        for (const bucket of buckets) bucket.stats.ignoredNonMonotonic += 1;
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

function bucket(root, key) {
  root[key] ??= newStats();
  return root[key];
}

function nestedBucket(root, key1, key2) {
  root[key1] ??= {};
  root[key1][key2] ??= newStats();
  return root[key1][key2];
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

function lookupAnthropicPrices(model, timestamp) {
  const normalized = normalizeModel(model);
  const names = Object.keys(PRICING.anthropic.models).sort((a, b) => b.length - a.length);
  const key = names.find((name) => normalized === name || normalized.startsWith(`${name}-`));
  if (!key) return null;

  const entry = PRICING.anthropic.models[key];
  if (!Array.isArray(entry)) return entry;

  const ts = isValidDate(timestamp) ? timestamp.getTime() : Date.now();
  for (const timed of entry) {
    const from = timed.from ? Date.parse(timed.from) : Number.NEGATIVE_INFINITY;
    const until = timed.until ? Date.parse(timed.until) : Number.POSITIVE_INFINITY;
    if (ts >= from && ts <= until) return timed.prices;
  }
  return entry[entry.length - 1].prices;
}

function lookupOpenAIPrices(model, usage, options) {
  const normalized = normalizeModel(model);
  const names = Object.keys(PRICING.openai.models).sort((a, b) => b.length - a.length);
  const key = names.find((name) => isOpenAIModelPriceMatch(normalized, name));
  if (!key) return null;
  const entry = PRICING.openai.models[key];

  const mode = options.openaiContext;
  const hasLong = Boolean(entry.long);
  let variant = "short";
  if (mode === "long" && hasLong) {
    variant = "long";
  } else if (mode === "auto" && hasLong) {
    variant = openAIInputTokensForLongPricing(usage) > 272_000 ? "long" : "short";
  }

  return entry[variant] || entry.short;
}

function openAIInputTokensForLongPricing(usage) {
  return number(usage.input) + number(usage.cacheCreate5m) + number(usage.cacheCreate30m) + number(usage.cacheCreate1h) + number(usage.cacheRead);
}

function isOpenAIModelPriceMatch(normalized, priceKey) {
  if (normalized === priceKey) return true;
  const prefix = `${priceKey}-`;
  if (!normalized.startsWith(prefix)) return false;
  const suffix = normalized.slice(prefix.length);
  return /^\d{4}-\d{2}-\d{2}$/.test(suffix);
}

function calculateCost(provider, model, usage, timestamp, options) {
  const normalizedUsage = normalizeUsage(usage);
  const reasoningOutput = Math.min(number(normalizedUsage.reasoningOutput), number(normalizedUsage.output));
  if (provider === "anthropic") {
    const prices = lookupAnthropicPrices(model, timestamp);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const breakdown = {
      input: (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: (normalizedUsage.cacheCreate5m * prices.cacheCreate5m) / TOKENS_PER_PRICE_UNIT,
      cacheCreate30m: 0,
      cacheCreate1h: (normalizedUsage.cacheCreate1h * prices.cacheCreate1h) / TOKENS_PER_PRICE_UNIT,
      cacheRead: (normalizedUsage.cacheRead * prices.cacheRead) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: (reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
  }

  if (provider === "openai") {
    const prices = lookupOpenAIPrices(model, normalizedUsage, options);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const cachedInputPrice = prices.cachedInput ?? prices.input;
    const breakdown = {
      input: (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: 0,
      cacheCreate30m: (normalizedUsage.cacheCreate30m * number(prices.cacheCreate30m)) / TOKENS_PER_PRICE_UNIT,
      cacheCreate1h: 0,
      cacheRead: (normalizedUsage.cacheRead * cachedInputPrice) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: (reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT,
    };
  }

  return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
}

function sumCostBreakdown(breakdown) {
  return (
    number(breakdown.input) +
    number(breakdown.cacheCreate5m) +
    number(breakdown.cacheCreate30m) +
    number(breakdown.cacheCreate1h) +
    number(breakdown.cacheRead) +
    number(breakdown.output)
  );
}

function addUsage(report, record, options) {
  const timestamp = isValidDate(record.timestamp) ? record.timestamp : new Date(NaN);
  const project = record.project || UNKNOWN_PROJECT;
  const model = record.model || UNKNOWN_MODEL;
  const provider = record.provider || inferProvider(model);
  const effort = normalizeEffort(record.effort);
  const usage = normalizeUsage(record.usage);
  const cost = calculateCost(provider, model, usage, timestamp, options);
  const visibleChars = normalizeVisibleChars(record.visibleChars, usage);

  addToStats(report.total, usage, cost, visibleChars);
  addToStats(bucket(report.daily, dateKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.weekly, weekKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.monthly, monthKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.yearly, yearKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.providers, provider), usage, cost, visibleChars);
  addToStats(bucket(report.models, model), usage, cost, visibleChars);
  addToStats(bucket(report.providerModels, `${provider}/${model}`), usage, cost, visibleChars);
  addToStats(bucket(report.projects, project), usage, cost, visibleChars);
  addToStats(nestedBucket(report.projectDaily, project, dateKey(timestamp)), usage, cost, visibleChars);
  addToStats(nestedBucket(report.projectModels, project, model), usage, cost, visibleChars);
  addToStats(bucket(report.efforts, effort), usage, cost, visibleChars);
  addToStats(nestedBucket(report.modelEfforts, model, effort), usage, cost, visibleChars);

  if (!cost.known) {
    const key = `${provider}/${model}`;
    report.unpricedModels[key] ??= { provider, model, requests: 0 };
    report.unpricedModels[key].requests += 1;
  }

  const event = {
    sourcePath: record.sourcePath || null,
    lineNo: Number.isFinite(record.lineNo) ? record.lineNo : null,
    timestamp: isValidDate(timestamp) ? timestamp.toISOString() : null,
    provider,
    model,
    project,
    effort,
    usage,
    cost: {
      known: cost.known,
      amount: cost.amount,
      reasoningAmount: cost.reasoningAmount,
      breakdown: cost.breakdown,
    },
    visibleChars,
  };
  if (typeof report._usageEventSink === "function") {
    report._usageEventSink(event);
  } else {
    report._usageEvents.push(event);
  }

  return { timestamp, project, model, provider, effort, usage, cost, visibleChars };
}

function normalizeUsage(usage) {
  const source = usage || {};
  const cacheRead = number(source.cacheRead);
  const rawInput = number(source.input);
  const inputIncludesCacheRead = source.inputIncludesCacheRead !== false;
  const input = inputIncludesCacheRead ? Math.max(0, rawInput - cacheRead) : rawInput;
  const output = number(source.output);
  const reasoningOutput = Math.min(number(source.reasoningOutput), output);
  return {
    input,
    cacheCreate5m: number(source.cacheCreate5m),
    cacheCreate30m: number(source.cacheCreate30m),
    cacheCreate1h: number(source.cacheCreate1h),
    cacheRead,
    output,
    reasoningOutput,
    contextWindow: number(source.contextWindow),
    inputIncludesCacheRead: false,
  };
}

function normalizeEffort(effort) {
  if (typeof effort !== "string" || effort.trim() === "") return UNKNOWN_EFFORT;
  return effort.trim().toLowerCase();
}

function usageFromCodexTokenUsage(tokenUsage, contextWindow) {
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(tokenUsage, key);
  const nestedDetails = tokenUsage.input_tokens_details ?? tokenUsage.prompt_tokens_details;
  const hasOfficialNestedDetails = Boolean(
    nestedDetails &&
    typeof nestedDetails === "object" &&
    (Object.prototype.hasOwnProperty.call(nestedDetails, "cached_tokens") ||
      Object.prototype.hasOwnProperty.call(nestedDetails, "cache_write_tokens")),
  );
  const details = hasOfficialNestedDetails ? nestedDetails : {};
  const cacheCreation = tokenUsage.cache_creation || tokenUsage.cacheCreation || {};
  const hasExplicitCacheFormat = hasOwn("cache_creation_input_tokens") ||
    hasOwn("cache_write_input_tokens") ||
    hasOwn("cache_create_input_tokens") ||
    hasOwn("cache_read_input_tokens") ||
    hasOwn("cache_creation") ||
    hasOwn("cacheCreation");
  const cacheCreate30m = hasOfficialNestedDetails
    ? number(details.cache_write_tokens)
    : number(
      tokenUsage.cache_creation_input_tokens ??
      tokenUsage.cache_write_input_tokens ??
      tokenUsage.cache_create_input_tokens ??
      cacheCreation.ephemeral_30m_input_tokens ??
      cacheCreation.thirty_minute_input_tokens,
    );
  const cacheRead = hasOfficialNestedDetails
    ? number(details.cached_tokens)
    : number(tokenUsage.cache_read_input_tokens ?? tokenUsage.cached_input_tokens);
  const rawInput = number(tokenUsage.input_tokens ?? tokenUsage.prompt_tokens);
  return {
    input: hasOfficialNestedDetails
      ? Math.max(0, rawInput - cacheRead - cacheCreate30m)
      : hasExplicitCacheFormat
        ? rawInput
        : Math.max(0, rawInput - cacheRead),
    inputCounter: rawInput,
    cacheCreate5m: 0,
    cacheCreate30m,
    cacheCreate1h: 0,
    cacheRead,
    output: number(tokenUsage.output_tokens),
    reasoningOutput: number(tokenUsage.reasoning_output_tokens),
    contextWindow,
    inputIncludesCacheRead: false,
  };
}

function subtractUsage(current, previous) {
  if (
    current.inputCounter < previous.inputCounter ||
    current.cacheCreate5m < previous.cacheCreate5m ||
    current.cacheCreate30m < previous.cacheCreate30m ||
    current.cacheCreate1h < previous.cacheCreate1h ||
    current.cacheRead < previous.cacheRead ||
    current.output < previous.output ||
    current.reasoningOutput < previous.reasoningOutput
  ) {
    return { ...current, sequenceReset: true };
  }

  return {
    input: Math.max(0, current.input - previous.input),
    inputCounter: Math.max(0, current.inputCounter - previous.inputCounter),
    cacheCreate5m: 0,
    cacheCreate30m: Math.max(0, current.cacheCreate30m - previous.cacheCreate30m),
    cacheCreate1h: 0,
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    output: Math.max(0, current.output - previous.output),
    reasoningOutput: Math.max(0, current.reasoningOutput - previous.reasoningOutput),
    contextWindow: current.contextWindow,
    inputIncludesCacheRead: current.inputIncludesCacheRead,
  };
}

function hasUsageTokens(usage) {
  return (
    usage.input > 0 ||
    usage.cacheCreate5m > 0 ||
    usage.cacheCreate30m > 0 ||
    usage.cacheCreate1h > 0 ||
    usage.cacheRead > 0 ||
    usage.output > 0 ||
    usage.reasoningOutput > 0
  );
}

function usageFromCodexInfo(info, previousTotalUsage = null, preferLastTokenUsage = false) {
  const contextWindow = number(info.model_context_window);
  if (info.total_token_usage) {
    const totalUsage = usageFromCodexTokenUsage(info.total_token_usage, contextWindow);
    const lastUsage = info.last_token_usage
      ? usageFromCodexTokenUsage(info.last_token_usage, contextWindow)
      : null;
    const usage = preferLastTokenUsage && lastUsage
      ? lastUsage
      : previousTotalUsage ? subtractUsage(totalUsage, previousTotalUsage) : totalUsage;
    return {
      usage,
      totalUsage: usage.sequenceReset ? null : totalUsage,
    };
  }

  const last = info.last_token_usage || info;
  return {
    usage: usageFromCodexTokenUsage(last, contextWindow),
    totalUsage: null,
  };
}

function usageFromClaudeUsage(usage) {
  const cacheCreation = usage.cache_creation || {};
  const cacheCreate5m = number(cacheCreation.ephemeral_5m_input_tokens);
  const cacheCreate1h = number(cacheCreation.ephemeral_1h_input_tokens);
  const totalCacheCreate = number(usage.cache_creation_input_tokens);
  const outputDetails = usage.output_tokens_details || usage.output_token_details || usage.output_details || {};

  return {
    input: number(usage.input_tokens),
    cacheCreate5m,
    cacheCreate30m: 0,
    cacheCreate1h: cacheCreate1h || Math.max(0, totalCacheCreate - cacheCreate5m),
    cacheRead: number(usage.cache_read_input_tokens),
    output: number(usage.output_tokens),
    reasoningOutput: number(outputDetails.thinking_tokens || usage.thinking_tokens),
    contextWindow: 0,
    inputIncludesCacheRead: false,
  };
}

function effortFromCodexTurnContext(payload) {
  return normalizeEffort(
    payload?.effort ||
    payload?.collaboration_mode?.settings?.reasoning_effort
  );
}

function visibleTextChars(value, depth = 0) {
  if (depth > 4 || value == null) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + visibleTextChars(item, depth + 1), 0);
  if (typeof value !== "object") return 0;
  if (typeof value.text === "string") return value.text.length;
  if (typeof value.output_text === "string") return value.output_text.length;
  if (typeof value.input_text === "string") return value.input_text.length;
  if (value.content !== undefined) return visibleTextChars(value.content, depth + 1);
  return 0;
}

function addVisibleChars(target, kind, chars) {
  if (!chars) return;
  if (kind === "output") target.output += chars;
  else target.input += chars;
}

function addCodexVisibleChars(target, json) {
  if (json.type === "event_msg") {
    const payload = json.payload || {};
    if (payload.type === "user_message") addVisibleChars(target, "input", visibleTextChars(payload.message));
    else if (payload.type === "agent_message") addVisibleChars(target, "output", visibleTextChars(payload.message));
    return;
  }

  if (json.type !== "response_item") return;
  const payload = json.payload || {};
  if (payload.type === "message") {
    const role = payload.role || "assistant";
    const kind = role === "assistant" ? "output" : "input";
    addVisibleChars(target, kind, visibleTextChars(payload.content));
  } else if (payload.type === "function_call") {
    addVisibleChars(target, "output", visibleTextChars(payload.arguments));
  } else if (payload.type === "function_call_output") {
    addVisibleChars(target, "input", visibleTextChars(payload.output));
  }
}

function codexAssistantOutputTextChars(json) {
  if (json.type !== "response_item") return 0;
  const payload = json.payload || {};
  if (payload.type !== "message") return 0;
  if ((payload.role || "assistant") !== "assistant") return 0;
  return visibleTextChars(payload.content);
}

const CODEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeCodexUuid(value) {
  if (typeof value !== "string") return null;
  return CODEX_UUID_RE.test(value) ? value.toLowerCase() : null;
}

function sameCodexUuid(left, right) {
  const normalizedLeft = normalizeCodexUuid(left);
  const normalizedRight = normalizeCodexUuid(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function codexTraceIds(json) {
  const payload = json?.payload || {};
  const ids = [];
  if (typeof payload.turn_id === "string" && payload.turn_id) ids.push(`turn:${payload.turn_id}`);
  if (typeof payload.call_id === "string" && payload.call_id) ids.push(`call:${payload.call_id}`);
  return ids;
}

function createLineProcessor(report, options, sourceLabel, session = null) {
  const newTurn = (turnId, timestamp) => ({
    turnId: turnId || null,
    timestamp: isValidDate(timestamp) ? timestamp : new Date(NaN),
    project: UNKNOWN_PROJECT,
    model: UNKNOWN_MODEL,
    provider: "openai",
    effort: UNKNOWN_EFFORT,
    visibleOutputChars: 0,
    output: 0,
    reasoningOutput: 0,
    hasOutputCharMetric: false,
  });
  const codexState = {
    sessionId: null,
    forkedFromId: null,
    forkParentTraces: null,
    skippingForkReplay: false,
    preScannedForkReplay: false,
    preferLastTokenUsageAfterForkReplay: false,
    project: UNKNOWN_PROJECT,
    model: UNKNOWN_MODEL,
    provider: "openai",
    effort: UNKNOWN_EFFORT,
    totalUsage: null,
    visibleChars: newVisibleChars(),
    turn: null,
  };
  const seenClaudeRequests = new Set();

  const updateTurnMeta = () => {
    if (!codexState.turn) return;
    codexState.turn.project = codexState.project;
    codexState.turn.model = codexState.model;
    codexState.turn.provider = codexState.provider || "openai";
    codexState.turn.effort = codexState.effort;
  };

  const flushTurn = () => {
    const turn = codexState.turn;
    if (!turn) return null;
    updateTurnMeta();
    const visibleOutputTokens = outputTextTokens(turn);
    let event = null;
    if (!turn.hasOutputCharMetric && turn.visibleOutputChars > 0 && visibleOutputTokens > 0) {
      event = addOutputCharTokenMetric(report, {
        sourcePath: session?.path || sourceLabel,
        turnId: turn.turnId,
        timestamp: turn.timestamp,
        provider: turn.provider,
        model: turn.model,
        project: turn.project,
        effort: turn.effort,
        visibleOutputChars: turn.visibleOutputChars,
        visibleOutputTokens,
      });
      if (session) addOutputCharTokenStats(session.stats, event);
    }
    codexState.turn = null;
    return event;
  };

  const beginForkReplay = () => {
    if (!codexState.skippingForkReplay) {
      codexState.totalUsage = null;
      codexState.visibleChars = newVisibleChars();
      flushTurn();
    }
    codexState.skippingForkReplay = true;
  };

  const endForkReplay = () => {
    codexState.skippingForkReplay = false;
    codexState.totalUsage = null;
    codexState.preferLastTokenUsageAfterForkReplay = true;
  };

  const ensureTurn = (turnId, timestamp) => {
    const normalizedTurnId = turnId || null;
    const timestampValue = isValidDate(timestamp) ? timestamp : new Date(NaN);
    if (codexState.turn && normalizedTurnId && codexState.turn.turnId && normalizedTurnId !== codexState.turn.turnId) {
      flushTurn();
    }
    if (!codexState.turn) {
      codexState.turn = newTurn(normalizedTurnId, timestampValue);
    } else if (!codexState.turn.turnId && normalizedTurnId) {
      codexState.turn.turnId = normalizedTurnId;
    }
    if (!isValidDate(codexState.turn.timestamp) && isValidDate(timestampValue)) {
      codexState.turn.timestamp = timestampValue;
    }
    updateTurnMeta();
  };

  const processor = (line, lineNo) => {
    if (!line.trim()) return;

    let json;
    try {
      json = JSON.parse(line);
    } catch {
      report.sources.parseErrors += 1;
      if (session) session.parseErrors += 1;
      if (options.strictJson) {
        throw new Error(`Invalid JSON in ${sourceLabel}:${lineNo}`);
      }
      return;
    }

    if (session) session.records += 1;

    if (json.type === "session_meta" && json.payload) {
      if (!codexState.sessionId) {
        codexState.sessionId = json.payload.id || null;
        codexState.forkedFromId = json.payload.forked_from_id || null;
        codexState.forkParentTraces = codexState.forkedFromId
          ? options.codexForkRegistry?.tracesBySession?.get(codexState.forkedFromId) || null
          : null;
        codexState.preScannedForkReplay = Boolean(
          codexState.sessionId &&
          options.codexForkRegistry?.replaySessions?.has(normalizeCodexUuid(codexState.sessionId)),
        );
        if (codexState.preScannedForkReplay) beginForkReplay();
      } else if (
        codexState.forkedFromId &&
        sameCodexUuid(json.payload.id, codexState.forkedFromId)
      ) {
        beginForkReplay();
        return;
      }
      codexState.project = json.payload.cwd || codexState.project;
      codexState.provider = json.payload.model_provider || codexState.provider;
      codexState.model = json.payload.model || codexState.model;
      return;
    }

    const traceIds = codexTraceIds(json);
    if (codexState.forkParentTraces) {
      if (traceIds.some((traceId) => codexState.forkParentTraces.has(traceId))) {
        beginForkReplay();
        return;
      }
      if (codexState.skippingForkReplay) {
        if (traceIds.length === 0) return;
        endForkReplay();
      }
    }

    if (codexState.skippingForkReplay) {
      if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
        const codexUsage = usageFromCodexInfo(json.payload.info, codexState.totalUsage);
        codexState.totalUsage = codexUsage.totalUsage || null;
      }
      if (codexTraceIds(json).length > 0 && !codexState.forkParentTraces) endForkReplay();
      if (codexState.skippingForkReplay) return;
    }

    if (json.type === "event_msg" && json.payload?.type === "task_started") {
      ensureTurn(json.payload.turn_id || null, new Date(json.timestamp));
    } else if (json.type === "turn_context" && json.payload?.turn_id) {
      ensureTurn(json.payload.turn_id, new Date(json.timestamp));
    }

    const assistantOutputTextChars = codexAssistantOutputTextChars(json);
    addCodexVisibleChars(codexState.visibleChars, json);
    if (assistantOutputTextChars > 0) {
      ensureTurn(null, new Date(json.timestamp));
      codexState.turn.visibleOutputChars += assistantOutputTextChars;
    }

    if (json.type === "turn_context" && json.payload) {
      codexState.project = json.payload.cwd || codexState.project;
      codexState.model = json.payload.model || codexState.model;
      codexState.effort = effortFromCodexTurnContext(json.payload);
      updateTurnMeta();
      return;
    }

    if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
      report.sources.tokenCountSnapshots += 1;
      if (session) session.tokenCountSnapshots += 1;

      const timestamp = new Date(json.timestamp);
      const codexUsage = usageFromCodexInfo(
        json.payload.info,
        codexState.totalUsage,
        codexState.preferLastTokenUsageAfterForkReplay,
      );
      codexState.totalUsage = codexUsage.totalUsage || null;
      codexState.preferLastTokenUsageAfterForkReplay = false;
      const provider = codexState.provider || "openai";
      const model = codexState.model;
      const effort = codexState.effort;
      ensureTurn(null, timestamp);
      codexState.turn.output += codexUsage.usage.output;
      codexState.turn.reasoningOutput += codexUsage.usage.reasoningOutput;

      if (!hasUsageTokens(codexUsage.usage)) {
        addRateLimitSnapshot(report, json.payload.rate_limits, {
          agent: AGENT_CODEX,
          provider,
          model,
          effort,
          timestamp,
          sourcePath: session?.path || sourceLabel,
          lineNo,
          usage: normalizeUsage(codexUsage.usage),
          cost: { known: true, amount: 0, reasoningAmount: 0 },
        });
        report.sources.skippedTokenCountSnapshots += 1;
        if (session) session.skippedTokenCountSnapshots += 1;
        return;
      }

      const added = addUsage(report, {
        provider,
        model,
        project: codexState.project,
        effort,
        timestamp,
        usage: codexUsage.usage,
        visibleChars: codexState.visibleChars,
        sourcePath: session?.path || sourceLabel,
        lineNo,
      }, options);
      const visibleOutputTokens = outputTextTokens(added.usage);
      if (added.visibleChars.output > 0 && visibleOutputTokens > 0) {
        const charsPerToken = added.visibleChars.output / visibleOutputTokens;
        if (charsPerToken <= MAX_VALID_OUTPUT_CHARS_PER_TOKEN) {
          codexState.turn.hasOutputCharMetric = true;
        }
        const outputCharMetric = addOutputCharTokenMetric(report, {
          sourcePath: session?.path || sourceLabel,
          turnId: codexState.turn?.turnId || null,
          timestamp,
          provider,
          model,
          project: codexState.project,
          effort,
          visibleOutputChars: added.visibleChars.output,
          visibleOutputTokens,
        });
        if (session) addOutputCharTokenStats(session.stats, outputCharMetric);
      }
      codexState.visibleChars = newVisibleChars();
      addRateLimitSnapshot(report, json.payload.rate_limits, {
        agent: AGENT_CODEX,
        provider,
        model,
        effort,
        timestamp,
        sourcePath: session?.path || sourceLabel,
        lineNo,
        usage: added.usage,
        cost: added.cost,
      });
      if (session) addToStats(session.stats, added.usage, added.cost, added.visibleChars);
      return;
    }

    if (json.type === "assistant" && json.message?.usage) {
      const requestKey = json.requestId || json.uuid;
      if (requestKey && seenClaudeRequests.has(requestKey)) return;
      if (requestKey) seenClaudeRequests.add(requestKey);

      const model = json.message.model || UNKNOWN_MODEL;
      const added = addUsage(report, {
        provider: inferProvider(model, "anthropic"),
        model,
        project: json.cwd || UNKNOWN_PROJECT,
        effort: UNKNOWN_EFFORT,
        timestamp: new Date(json.timestamp),
        usage: usageFromClaudeUsage(json.message.usage),
        sourcePath: session?.path || sourceLabel,
        lineNo,
      }, options);
      if (session) addToStats(session.stats, added.usage, added.cost);
    }
  };
  if (typeof report._afterLine === "function") processor.afterLine = report._afterLine;
  processor.finalize = () => {
    flushTurn();
    return typeof processor.afterLine === "function" ? processor.afterLine() : null;
  };
  return processor;
}

async function processJsonlFile(filename, report, options) {
  report.sources.files += 1;
  const stat = await fsp.stat(filename);
  const session = startSession(report, options, {
    kind: "jsonl",
    path: filename,
    sizeBytes: stat.size,
  });
  const processor = createLineProcessor(report, options, filename, session);
  const stream = fs.createReadStream(filename, { encoding: "utf8" });
  try {
    await processLineStream(stream, processor, session);
  } finally {
    finishSession(session, options);
  }
}

async function processLineStream(stream, processor, session = null) {
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (session) session.lines += 1;
    processor(line, lineNo);
    if (typeof processor.afterLine === "function") {
      const drain = processor.afterLine();
      if (drain && typeof drain.then === "function") await drain;
    }
  }
  if (typeof processor.finalize === "function") {
    const drain = processor.finalize();
    if (drain && typeof drain.then === "function") await drain;
  }
}

async function processZipEntry(zipFile, entry, report, options) {
  report.sources.zipEntries += 1;
  const session = startSession(report, options, {
    kind: "zip-entry",
    path: `${zipFile}:${entry.fileName}`,
    archivePath: zipFile,
    entryName: entry.fileName,
    sizeBytes: entry.uncompressedSize,
    compressedSizeBytes: entry.compressedSize,
  });
  const stream = await openZipEntryStream(zipFile, entry);
  const processor = createLineProcessor(report, options, `${zipFile}:${entry.fileName}`, session);
  try {
    await processLineStream(stream, processor, session);
  } finally {
    finishSession(session, options);
  }
}

async function processZipFile(zipFile, report, options, limiter) {
  report.sources.zipFiles += 1;
  const stat = await fsp.stat(zipFile);
  const entries = (await listZipEntries(zipFile))
    .filter((entry) => entry.fileName.endsWith(".jsonl"))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  logProgress(options, `[zip] ${zipFile} size=${formatBytes(stat.size)} entries=${formatInt(entries.length)}`);
  for (const entry of entries) {
    if (!limiter.take()) {
      report.sources.skippedFiles += 1;
      continue;
    }
    await processZipEntry(zipFile, entry, report, options);
  }
}

async function listZipEntries(zipFile) {
  const handle = await fsp.open(zipFile, "r");
  try {
    const stat = await handle.stat();
    const eocd = await readZipEndOfCentralDirectory(handle, stat.size);
    if (eocd.centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error(`Central directory too large in ${zipFile}: ${eocd.centralDirectorySize} bytes`);
    }

    const centralDirectory = await readAt(handle, eocd.centralDirectorySize, eocd.centralDirectoryOffset);
    return parseCentralDirectory(centralDirectory, eocd.entriesTotal);
  } finally {
    await handle.close();
  }
}

async function openZipEntryStream(zipFile, entry) {
  const handle = await fsp.open(zipFile, "r");
  let localHeader;
  try {
    localHeader = await readZipLocalHeader(handle, entry.localHeaderOffset);
  } finally {
    await handle.close();
  }

  if (entry.compressedSize === 0) {
    return Readable.from([]);
  }

  const compressed = fs.createReadStream(zipFile, {
    start: localHeader.dataOffset,
    end: localHeader.dataOffset + entry.compressedSize - 1,
  });

  if (entry.method === 0) return compressed;
  if (entry.method === 8) return compressed.pipe(zlib.createInflateRaw());
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.fileName}`);
}

async function readZipEndOfCentralDirectory(handle, fileSize) {
  const scanSize = Math.min(fileSize, 22 + 0xffff);
  const scanStart = fileSize - scanSize;
  const buffer = await readAt(handle, scanSize, scanStart);

  let eocdOffsetInBuffer = -1;
  for (let pos = buffer.length - 22; pos >= 0; pos -= 1) {
    if (buffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffsetInBuffer = pos;
      break;
    }
  }

  if (eocdOffsetInBuffer < 0) {
    throw new Error("ZIP end of central directory was not found");
  }

  const eocdOffset = scanStart + eocdOffsetInBuffer;
  const commentLength = buffer.readUInt16LE(eocdOffsetInBuffer + 20);
  const expectedLength = 22 + commentLength;
  if (eocdOffsetInBuffer + expectedLength > buffer.length) {
    throw new Error("Truncated ZIP end of central directory");
  }

  const diskNumber = buffer.readUInt16LE(eocdOffsetInBuffer + 4);
  const centralDirectoryDisk = buffer.readUInt16LE(eocdOffsetInBuffer + 6);
  const entriesDisk = buffer.readUInt16LE(eocdOffsetInBuffer + 8);
  const entriesTotal = buffer.readUInt16LE(eocdOffsetInBuffer + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffsetInBuffer + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffsetInBuffer + 16);

  const needsZip64 =
    entriesDisk === 0xffff ||
    entriesTotal === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff;

  if (!needsZip64) {
    return { entriesTotal, centralDirectorySize, centralDirectoryOffset };
  }

  if (eocdOffset < 20) {
    throw new Error("ZIP64 locator is missing");
  }

  const locator = await readAt(handle, 20, eocdOffset - 20);
  if (locator.readUInt32LE(0) !== 0x07064b50) {
    throw new Error("ZIP64 locator signature was not found");
  }

  const zip64EocdOffset = readUInt64LEAsNumber(locator, 8);
  const zip64Header = await readAt(handle, 56, zip64EocdOffset);
  if (zip64Header.readUInt32LE(0) !== 0x06064b50) {
    throw new Error("ZIP64 end of central directory signature was not found");
  }

  const zip64DiskNumber = zip64Header.readUInt32LE(16);
  const zip64CentralDirectoryDisk = zip64Header.readUInt32LE(20);
  if (diskNumber !== 0xffff && diskNumber !== zip64DiskNumber) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }
  if (centralDirectoryDisk !== 0xffff && centralDirectoryDisk !== zip64CentralDirectoryDisk) {
    throw new Error("Multi-disk ZIP archives are not supported");
  }

  return {
    entriesTotal: readUInt64LEAsNumber(zip64Header, 32),
    centralDirectorySize: readUInt64LEAsNumber(zip64Header, 40),
    centralDirectoryOffset: readUInt64LEAsNumber(zip64Header, 48),
  };
}

function parseCentralDirectory(buffer, expectedEntries) {
  const entries = [];
  let offset = 0;

  while (offset < buffer.length && entries.length < expectedEntries) {
    if (offset + 46 > buffer.length) {
      throw new Error("Truncated ZIP central directory entry");
    }
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("Unexpected ZIP central directory signature");
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    let compressedSize = buffer.readUInt32LE(offset + 20);
    let uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    let localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const variableStart = offset + 46;
    const variableEnd = variableStart + fileNameLength + extraLength + commentLength;

    if (variableEnd > buffer.length) {
      throw new Error("Truncated ZIP central directory variable data");
    }

    const fileName = buffer.toString("utf8", variableStart, variableStart + fileNameLength);
    const extra = buffer.subarray(variableStart + fileNameLength, variableStart + fileNameLength + extraLength);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const zip64 = parseZip64Extra(extra, {
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      compressedSize = zip64.compressedSize;
      uncompressedSize = zip64.uncompressedSize;
      localHeaderOffset = zip64.localHeaderOffset;
    }

    entries.push({ fileName, flags, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset = variableEnd;
  }

  return entries;
}

function parseZip64Extra(extra, values) {
  let offset = 0;
  let {
    compressedSize,
    uncompressedSize,
    localHeaderOffset,
  } = values;

  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > extra.length) break;

    if (headerId === 0x0001) {
      let pos = dataStart;
      if (uncompressedSize === 0xffffffff) {
        uncompressedSize = readUInt64LEAsNumber(extra, pos);
        pos += 8;
      }
      if (compressedSize === 0xffffffff) {
        compressedSize = readUInt64LEAsNumber(extra, pos);
        pos += 8;
      }
      if (localHeaderOffset === 0xffffffff) {
        localHeaderOffset = readUInt64LEAsNumber(extra, pos);
      }
      return { compressedSize, uncompressedSize, localHeaderOffset };
    }

    offset = dataEnd;
  }

  throw new Error("ZIP64 extra field is missing required size or offset data");
}

async function readZipLocalHeader(handle, localHeaderOffset) {
  const fixed = await readAt(handle, 30, localHeaderOffset);
  if (fixed.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("Unexpected ZIP local file header signature");
  }

  const fileNameLength = fixed.readUInt16LE(26);
  const extraLength = fixed.readUInt16LE(28);
  return {
    dataOffset: localHeaderOffset + 30 + fileNameLength + extraLength,
  };
}

async function readAt(handle, length, position) {
  if (length < 0 || position < 0) {
    throw new Error(`Invalid read: length=${length}, position=${position}`);
  }
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw new Error(`Short read: expected ${length}, got ${bytesRead}`);
  }
  return buffer;
}

function readUInt64LEAsNumber(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`ZIP value exceeds JavaScript safe integer: ${value.toString()}`);
  }
  return Number(value);
}

async function walkFiles(root, predicate, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return out;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = Path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(fullPath, predicate, out);
    } else if (entry.isFile() && predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

async function discoverInputs(options) {
  const inputs = [];
  const home = options.home;
  const source = options.source;

  if (options.paths.length > 0) {
    for (const inputPath of options.paths) {
      await addInputPath(Path.resolve(inputPath), inputs, options.includeArchives);
    }
    return sortInputs(inputs);
  }

  if (source === "all" || source === "claude") {
    const claudeRoot = Path.join(home, ".claude", "projects");
    const files = await walkFiles(claudeRoot, (p) => p.endsWith(".jsonl"));
    inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));
  }

  if (source === "all" || source === "codex") {
    const codexRoot = Path.join(home, ".codex", "sessions");
    const files = await walkFiles(codexRoot, (p) => p.endsWith(".jsonl"));
    inputs.push(...files.map((p) => ({ kind: "jsonl", path: p })));

    if (options.includeArchives) {
      const archivesRoot = Path.join(home, ".codex", "archived_sessions");
      const archives = await walkFiles(archivesRoot, (p) => p.endsWith(".zip"));
      inputs.push(...archives.map((p) => ({ kind: "zip", path: p })));
    }
  }

  return sortInputs(inputs);
}

function codexJsonlSource(path) {
  return {
    kind: "jsonl",
    label: path,
    sourcePath: path,
    archivePath: null,
    entryName: null,
    openStream: () => fs.createReadStream(path, { encoding: "utf8" }),
  };
}

function codexZipEntrySource(archivePath, entry) {
  return {
    kind: "zip-entry",
    label: `${archivePath}:${entry.fileName}`,
    sourcePath: `${archivePath}:${entry.fileName}`,
    archivePath,
    entryName: entry.fileName,
    openStream: () => openZipEntryStream(archivePath, entry),
  };
}

function storedCodexZipEntrySource(sourcePath, archivePath, entryName) {
  return {
    kind: "zip-entry",
    label: sourcePath,
    sourcePath,
    archivePath,
    entryName,
    openStream: async () => {
      const entry = (await listZipEntries(archivePath)).find((candidate) => candidate.fileName === entryName);
      if (!entry) throw new Error(`Archived Codex source is missing: ${sourcePath}`);
      return openZipEntryStream(archivePath, entry);
    },
  };
}

function storedCodexSessionHeader(row) {
  const id = normalizeCodexUuid(row.sessionId ?? row.session_id);
  const forkedFromId = normalizeCodexUuid(row.parentSessionId ?? row.parent_session_id);
  const kind = row.kind;
  const sourcePath = row.sourcePath ?? row.source_path;
  const archivePath = row.archivePath ?? row.archive_path;
  const entryName = row.entryName ?? row.entry_name;
  let source = null;

  if (kind === "jsonl" && sourcePath) {
    source = codexJsonlSource(sourcePath);
  } else if (kind === "zip-entry" && sourcePath && archivePath && entryName) {
    source = storedCodexZipEntrySource(sourcePath, archivePath, entryName);
  }

  return id && source ? { id, forkedFromId, source } : null;
}

async function collectCodexSources(inputs) {
  const sources = [];
  for (const input of inputs) {
    if (input.kind === "jsonl") {
      sources.push(codexJsonlSource(input.path));
      continue;
    }
    if (input.kind !== "zip") continue;

    const entries = (await listZipEntries(input.path))
      .filter((entry) => entry.fileName.endsWith(".jsonl"));
    for (const entry of entries) {
      sources.push(codexZipEntrySource(input.path, entry));
    }
  }
  return sources;
}

async function readCodexSessionHeader(source) {
  const stream = await source.openStream();
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const json = JSON.parse(line);
      const id = normalizeCodexUuid(json.payload?.id);
      if (json.type !== "session_meta" || !id) return null;
      return {
        id,
        forkedFromId: normalizeCodexUuid(json.payload.forked_from_id),
        source,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function collectCodexOwnTraceIds(source, inheritedTraces, inheritedSessionId) {
  const ownTraces = new Set();
  let skippingInheritedReplay = false;
  let sawInheritedReplay = false;
  let stream;
  try {
    stream = await source.openStream();
  } catch {
    return { ownTraces, sawInheritedReplay };
  }
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json.type === "session_meta" && inheritedSessionId && sameCodexUuid(json.payload?.id, inheritedSessionId)) {
        skippingInheritedReplay = true;
        sawInheritedReplay = true;
        continue;
      }
      const traceIds = codexTraceIds(json);
      if (traceIds.some((traceId) => inheritedTraces.has(traceId))) {
        skippingInheritedReplay = true;
        sawInheritedReplay = true;
        continue;
      }
      if (skippingInheritedReplay) {
        if (traceIds.length === 0) continue;
        skippingInheritedReplay = false;
      }
      for (const traceId of traceIds) ownTraces.add(traceId);
    }
  } catch {
    return { ownTraces, sawInheritedReplay };
  } finally {
    lines.close();
    stream.destroy();
  }
  return { ownTraces, sawInheritedReplay };
}

async function prepareCodexForkRegistry(inputs, options) {
  if (options.codexForkRegistry) return options.codexForkRegistry;
  const codexInputs = await collectCodexSources(inputs);
  const currentHeaders = [];
  for (const input of codexInputs) {
    const header = await readCodexSessionHeader(input);
    if (header) currentHeaders.push(header);
  }
  const persistedHeaders = (options.persistedCodexSessionHeaders || [])
    .map(storedCodexSessionHeader)
    .filter(Boolean);
  const headersBySession = new Map(persistedHeaders.map((header) => [header.id, header]));
  for (const header of currentHeaders) headersBySession.set(header.id, header);
  const parentSessionIds = new Set(currentHeaders.map((header) => header.forkedFromId).filter(Boolean));
  const tracesBySession = new Map();
  const replaySessions = new Set();
  const visiting = new Set();

  const collectSessionTraces = async (sessionId) => {
    if (tracesBySession.has(sessionId)) return tracesBySession.get(sessionId);
    if (visiting.has(sessionId)) return new Set();
    const header = headersBySession.get(sessionId);
    if (!header) return new Set();
    visiting.add(sessionId);
    const inheritedTraces = header.forkedFromId
      ? await collectSessionTraces(header.forkedFromId)
      : new Set();
    const { ownTraces, sawInheritedReplay } = await collectCodexOwnTraceIds(
      header.source,
      inheritedTraces,
      header.forkedFromId,
    );
    if (sawInheritedReplay) replaySessions.add(sessionId);
    const traces = new Set(inheritedTraces);
    for (const traceId of ownTraces) traces.add(traceId);
    visiting.delete(sessionId);
    tracesBySession.set(sessionId, traces);
    return traces;
  };

  for (const parentSessionId of parentSessionIds) await collectSessionTraces(parentSessionId);
  for (const header of currentHeaders) await collectSessionTraces(header.id);
  return currentHeaders.length > 0 ? { tracesBySession, replaySessions, currentHeaders } : null;
}

async function processingOptionsWithCodexForkRegistry(options, inputs) {
  const registry = await prepareCodexForkRegistry(inputs, options);
  return registry ? { ...options, codexForkRegistry: registry } : options;
}

function sortInputs(inputs) {
  return inputs.sort((a, b) => {
    const byKind = a.kind.localeCompare(b.kind);
    if (byKind !== 0) return byKind;
    return a.path.localeCompare(b.path);
  });
}

async function addInputPath(inputPath, inputs, includeArchives) {
  const stat = await fsp.stat(inputPath);
  if (stat.isDirectory()) {
    const files = await walkFiles(inputPath, (p) => p.endsWith(".jsonl") || (includeArchives && p.endsWith(".zip")));
    for (const file of files) {
      inputs.push({ kind: file.endsWith(".zip") ? "zip" : "jsonl", path: file });
    }
  } else if (inputPath.endsWith(".zip")) {
    if (includeArchives) inputs.push({ kind: "zip", path: inputPath });
  } else if (inputPath.endsWith(".jsonl")) {
    inputs.push({ kind: "jsonl", path: inputPath });
  }
}

function createLimiter(limit) {
  let used = 0;
  return {
    take() {
      if (!Number.isFinite(limit)) return true;
      if (used >= limit) return false;
      used += 1;
      return true;
    },
  };
}

async function buildReport(options) {
  const report = newReport();
  const inputs = await discoverInputs(options);
  const processingOptions = await processingOptionsWithCodexForkRegistry(options, inputs);
  const limiter = createLimiter(options.limitFiles);

  for (const input of inputs) {
    if (input.kind === "jsonl") {
      if (!limiter.take()) {
        report.sources.skippedFiles += 1;
        continue;
      }
      await processJsonlFile(input.path, report, processingOptions);
    } else if (input.kind === "zip") {
      await processZipFile(input.path, report, processingOptions, limiter);
    }
  }

  finalizeRateLimits(report);
  return report;
}

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

function resolveDbPath(options) {
  return Path.resolve(options.db || Path.join(process.cwd(), DEFAULT_DB_FILENAME));
}

function ensureSqliteColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((existing) => existing.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function openTokenomicsDatabase(dbPath) {
  fs.mkdirSync(Path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      source_path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      archive_path TEXT,
      entry_name TEXT,
      fingerprint TEXT NOT NULL,
      size_bytes INTEGER,
      compressed_size_bytes INTEGER,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_sessions (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      source_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      archive_path TEXT,
      entry_name TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      source_path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      archive_path TEXT,
      entry_name TEXT,
      size_bytes INTEGER,
      compressed_size_bytes INTEGER,
      started_at TEXT,
      finished_at TEXT,
      duration_ms REAL NOT NULL,
      lines INTEGER NOT NULL,
      records INTEGER NOT NULL,
      parse_errors INTEGER NOT NULL,
      token_count_snapshots INTEGER NOT NULL,
      skipped_token_count_snapshots INTEGER NOT NULL,
      stats_json TEXT NOT NULL,
      FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL,
      line_no INTEGER,
      timestamp TEXT,
      date_key TEXT NOT NULL,
      week_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      year_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      project TEXT NOT NULL,
      effort TEXT NOT NULL,
      input INTEGER NOT NULL,
      cache_create_5m INTEGER NOT NULL,
      cache_create_30m INTEGER NOT NULL DEFAULT 0,
      cache_create_1h INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning_output INTEGER NOT NULL,
      context_window INTEGER NOT NULL,
      priced INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      reasoning_cost_usd REAL NOT NULL,
      cost_input_usd REAL NOT NULL,
      cost_cache_create_5m_usd REAL NOT NULL,
      cost_cache_create_30m_usd REAL NOT NULL DEFAULT 0,
      cost_cache_create_1h_usd REAL NOT NULL,
      cost_cache_read_usd REAL NOT NULL,
      cost_output_usd REAL NOT NULL,
      visible_input_chars INTEGER NOT NULL DEFAULT 0,
      visible_output_chars INTEGER NOT NULL DEFAULT 0,
      visible_total_chars INTEGER NOT NULL DEFAULT 0,
      visible_chars_per_token REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS output_char_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL,
      turn_id TEXT,
      timestamp TEXT,
      date_key TEXT NOT NULL,
      week_key TEXT NOT NULL,
      month_key TEXT NOT NULL,
      year_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      project TEXT NOT NULL,
      effort TEXT NOT NULL,
      visible_output_chars INTEGER NOT NULL,
      visible_output_tokens INTEGER NOT NULL,
      output_chars_per_token REAL NOT NULL,
      FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS rate_limit_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT,
      line_no INTEGER,
      sample_key TEXT NOT NULL,
      group_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      limit_id TEXT,
      limit_name TEXT,
      plan_type TEXT,
      kind TEXT NOT NULL,
      window_minutes INTEGER,
      used_percent REAL NOT NULL,
      resets_at INTEGER NOT NULL,
      reached INTEGER NOT NULL,
      agent TEXT NOT NULL,
      effort TEXT NOT NULL,
      model TEXT NOT NULL,
      input INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      output INTEGER NOT NULL,
      reasoning_output INTEGER NOT NULL,
      priced INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      reasoning_cost_usd REAL NOT NULL,
      FOREIGN KEY(source_path) REFERENCES sources(source_path) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_time ON usage_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);
    CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project);
    CREATE INDEX IF NOT EXISTS idx_output_char_metrics_time ON output_char_metrics(timestamp);
    CREATE INDEX IF NOT EXISTS idx_rate_limit_samples_group_time ON rate_limit_samples(group_key, timestamp_ms, sequence);
    CREATE INDEX IF NOT EXISTS idx_codex_sessions_parent ON codex_sessions(parent_session_id);
  `);
  ensureSqliteColumn(db, "usage_events", "visible_input_chars", "INTEGER NOT NULL DEFAULT 0");
  ensureSqliteColumn(db, "usage_events", "cache_create_30m", "INTEGER NOT NULL DEFAULT 0");
  ensureSqliteColumn(db, "usage_events", "cost_cache_create_30m_usd", "REAL NOT NULL DEFAULT 0");
  ensureSqliteColumn(db, "usage_events", "visible_output_chars", "INTEGER NOT NULL DEFAULT 0");
  ensureSqliteColumn(db, "usage_events", "visible_total_chars", "INTEGER NOT NULL DEFAULT 0");
  ensureSqliteColumn(db, "usage_events", "visible_chars_per_token", "REAL NOT NULL DEFAULT 0");
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1')").run();
  return db;
}

async function withAsyncTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function sourceFingerprint(parts) {
  return Object.entries(parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("|");
}

function codexSessionStorageRows(headers, updatedAt = new Date().toISOString()) {
  const rowsBySession = new Map();
  for (const header of headers || []) {
    const sessionId = normalizeCodexUuid(header?.id);
    const source = header?.source;
    if (!sessionId || !source?.sourcePath || !source.kind) continue;
    rowsBySession.set(sessionId, {
      sessionId,
      parentSessionId: normalizeCodexUuid(header.forkedFromId),
      sourcePath: source.sourcePath,
      kind: source.kind,
      archivePath: source.archivePath || null,
      entryName: source.entryName || null,
      updatedAt,
    });
  }
  return [...rowsBySession.values()];
}

function loadSqliteCodexSessionHeaders(db) {
  return db.prepare(`
    SELECT session_id, parent_session_id, source_path, kind, archive_path, entry_name
    FROM codex_sessions
  `).all();
}

function storeSqliteCodexSessionHeaders(db, headers) {
  const rows = codexSessionStorageRows(headers);
  if (rows.length === 0) return;
  const deleteBySource = db.prepare("DELETE FROM codex_sessions WHERE source_path = ?");
  const insert = db.prepare(`
    INSERT INTO codex_sessions(
      session_id, parent_session_id, source_path, kind, archive_path, entry_name, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      parent_session_id = excluded.parent_session_id,
      source_path = excluded.source_path,
      kind = excluded.kind,
      archive_path = excluded.archive_path,
      entry_name = excluded.entry_name,
      updated_at = excluded.updated_at
  `);
  for (const row of rows) {
    deleteBySource.run(row.sourcePath);
    insert.run(
      row.sessionId,
      row.parentSessionId,
      row.sourcePath,
      row.kind,
      row.archivePath,
      row.entryName,
      row.updatedAt,
    );
  }
}

function existingSourceFingerprint(db, sourcePath) {
  const row = db.prepare("SELECT fingerprint FROM sources WHERE source_path = ?").get(sourcePath);
  return row?.fingerprint || null;
}

function deleteSourceRows(db, sourcePath) {
  db.prepare("DELETE FROM usage_events WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM output_char_metrics WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM rate_limit_samples WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM sessions WHERE source_path = ?").run(sourcePath);
  db.prepare("DELETE FROM sources WHERE source_path = ?").run(sourcePath);
}

function prepareSourceStatements(db) {
  return {
    insertSource: db.prepare(`
    INSERT INTO sources(source_path, kind, archive_path, entry_name, fingerprint, size_bytes, compressed_size_bytes, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
    insertSession: db.prepare(`
    INSERT INTO sessions(
      source_path, kind, archive_path, entry_name, size_bytes, compressed_size_bytes,
      started_at, finished_at, duration_ms, lines, records, parse_errors,
      token_count_snapshots, skipped_token_count_snapshots, stats_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
    insertUsage: db.prepare(`
    INSERT INTO usage_events(
      source_path, line_no, timestamp, date_key, week_key, month_key, year_key,
      provider, model, project, effort,
      input, cache_create_5m, cache_create_30m, cache_create_1h, cache_read, output, reasoning_output,
      context_window, priced, cost_usd, reasoning_cost_usd,
      cost_input_usd, cost_cache_create_5m_usd, cost_cache_create_30m_usd, cost_cache_create_1h_usd,
      cost_cache_read_usd, cost_output_usd,
      visible_input_chars, visible_output_chars, visible_total_chars, visible_chars_per_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
    insertOutputCharMetric: db.prepare(`
    INSERT INTO output_char_metrics(
      source_path, turn_id, timestamp, date_key, week_key, month_key, year_key,
      provider, model, project, effort,
      visible_output_chars, visible_output_tokens, output_chars_per_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
    insertRateLimit: db.prepare(`
    INSERT INTO rate_limit_samples(
      source_path, line_no, sample_key, group_key, sequence, timestamp_ms,
      limit_id, limit_name, plan_type, kind, window_minutes,
      used_percent, resets_at, reached, agent, effort, model,
      input, cache_read, output, reasoning_output, priced, cost_usd, reasoning_cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  };
}

function insertSourceRow(statement, source, fingerprint) {
  statement.run(
    source.path,
    source.kind,
    source.archivePath || null,
    source.entryName || null,
    fingerprint,
    source.sizeBytes ?? null,
    source.compressedSizeBytes ?? null,
    new Date().toISOString(),
  );
}

function insertSessionRow(statement, session) {
  statement.run(
    session.path,
    session.kind,
    session.archivePath || null,
    session.entryName || null,
    session.sizeBytes ?? null,
    session.compressedSizeBytes ?? null,
    session.startedAt || null,
    session.finishedAt || null,
    number(session.durationMs),
    number(session.lines),
    number(session.records),
    number(session.parseErrors),
    number(session.tokenCountSnapshots),
    number(session.skippedTokenCountSnapshots),
    JSON.stringify(session.stats),
  );
}

function insertUsageEventRow(statement, event, defaultSourcePath) {
  const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
  statement.run(
    event.sourcePath || defaultSourcePath,
    event.lineNo,
    event.timestamp,
    dateKey(timestamp),
    weekKey(timestamp),
    monthKey(timestamp),
    yearKey(timestamp),
    event.provider,
    event.model,
    event.project,
    event.effort,
    event.usage.input,
    event.usage.cacheCreate5m,
    event.usage.cacheCreate30m,
    event.usage.cacheCreate1h,
    event.usage.cacheRead,
    event.usage.output,
    event.usage.reasoningOutput,
    event.usage.contextWindow,
    event.cost.known ? 1 : 0,
    number(event.cost.amount),
    number(event.cost.reasoningAmount),
    number(event.cost.breakdown.input),
    number(event.cost.breakdown.cacheCreate5m),
    number(event.cost.breakdown.cacheCreate30m),
    number(event.cost.breakdown.cacheCreate1h),
    number(event.cost.breakdown.cacheRead),
    number(event.cost.breakdown.output),
    number(event.visibleChars?.input),
    number(event.visibleChars?.output),
    number(event.visibleChars?.total),
    number(event.visibleChars?.charsPerToken),
  );
}

function insertOutputCharMetricRow(statement, event, defaultSourcePath) {
  const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
  statement.run(
    event.sourcePath || defaultSourcePath,
    event.turnId || null,
    event.timestamp,
    dateKey(timestamp),
    weekKey(timestamp),
    monthKey(timestamp),
    yearKey(timestamp),
    event.provider,
    event.model,
    event.project,
    event.effort,
    number(event.visibleOutputChars),
    number(event.visibleOutputTokens),
    number(event.charsPerToken),
  );
}

function insertRateLimitSampleRow(statement, sample, defaultSourcePath) {
  statement.run(
    sample.sourcePath || defaultSourcePath,
    sample.lineNo,
    sample.key,
    sample.groupKey,
    sample.sequence,
    sample.timestampMs,
    sample.windowMeta.limitId,
    sample.windowMeta.limitName,
    sample.windowMeta.planType,
    sample.windowMeta.kind,
    sample.windowMeta.windowMinutes,
    sample.usedPercent,
    sample.resetsAt,
    sample.reached ? 1 : 0,
    sample.agent,
    sample.effort,
    sample.model,
    sample.usage.input,
    sample.usage.cacheRead,
    sample.usage.output,
    sample.usage.reasoningOutput,
    sample.cost.known ? 1 : 0,
    sample.cost.amount,
    sample.cost.reasoningAmount,
  );
}

async function processAndStoreSource(db, source, fingerprint, options) {
  const statements = prepareSourceStatements(db);
  return withAsyncTransaction(db, async () => {
    deleteSourceRows(db, source.path);
    insertSourceRow(statements.insertSource, source, fingerprint);

    const report = newReport();
    report._usageEventSink = (event) => insertUsageEventRow(statements.insertUsage, event, source.path);
    report._outputCharMetricSink = (event) => insertOutputCharMetricRow(statements.insertOutputCharMetric, event, source.path);
    report._rateLimitSampleSink = (sample) => insertRateLimitSampleRow(statements.insertRateLimit, sample, source.path);

    if (source.kind === "jsonl") {
      await processJsonlFile(source.path, report, options);
    } else if (source.kind === "zip-entry") {
      await processZipEntry(source.archivePath, source.entry, report, options);
    } else {
      throw new Error(`Unsupported database source kind: ${source.kind}`);
    }

    for (const session of report.sessions) {
      insertSessionRow(statements.insertSession, session);
    }
    return report;
  });
}

async function syncJsonlSource(db, input, options) {
  const stat = await fsp.stat(input.path);
  const fingerprint = sourceFingerprint({
    kind: "jsonl",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
  if (existingSourceFingerprint(db, input.path) === fingerprint) return false;

  const source = {
    kind: "jsonl",
    path: input.path,
    sizeBytes: stat.size,
  };
  await processAndStoreSource(db, source, fingerprint, options);
  return true;
}

async function syncZipSource(db, input, options, limiter) {
  const stat = await fsp.stat(input.path);
  const entries = (await listZipEntries(input.path))
    .filter((entry) => entry.fileName.endsWith(".jsonl"))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  logProgress(options, `[zip] ${input.path} size=${formatBytes(stat.size)} entries=${formatInt(entries.length)}`);

  let changed = 0;
  for (const entry of entries) {
    if (!limiter.take()) continue;
    const sourcePath = `${input.path}:${entry.fileName}`;
    const fingerprint = sourceFingerprint({
      kind: "zip-entry",
      archiveSize: stat.size,
      archiveMtimeMs: stat.mtimeMs,
      entry: entry.fileName,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      localHeaderOffset: entry.localHeaderOffset,
    });
    if (existingSourceFingerprint(db, sourcePath) === fingerprint) continue;

    const source = {
      kind: "zip-entry",
      path: sourcePath,
      archivePath: input.path,
      entryName: entry.fileName,
      sizeBytes: entry.uncompressedSize,
      compressedSizeBytes: entry.compressedSize,
      entry,
    };
    await processAndStoreSource(db, source, fingerprint, options);
    changed += 1;
  }
  return changed > 0;
}

async function syncSqliteDatabase(options) {
  const dbPath = resolveDbPath(options);
  const db = openTokenomicsDatabase(dbPath);
  try {
    const inputs = await discoverInputs(options);
    const persistedCodexSessionHeaders = [
      ...(options.persistedCodexSessionHeaders || []),
      ...loadSqliteCodexSessionHeaders(db),
    ];
    const processingOptions = await processingOptionsWithCodexForkRegistry({
      ...options,
      persistedCodexSessionHeaders,
    }, inputs);
    storeSqliteCodexSessionHeaders(db, processingOptions.codexForkRegistry?.currentHeaders);
    const limiter = createLimiter(options.limitFiles);
    let changed = 0;
    for (const input of inputs) {
      if (input.kind === "jsonl") {
        if (!limiter.take()) continue;
        if (await syncJsonlSource(db, input, processingOptions)) changed += 1;
      } else if (input.kind === "zip") {
        if (await syncZipSource(db, input, processingOptions, limiter)) changed += 1;
      }
    }
    const report = buildReportFromOpenDatabase(db, options);
    logProgress(options, `[db] ${dbPath} changed_sources=${formatInt(changed)} sessions=${formatInt(report.sessions.length)}`);
    return report;
  } finally {
    db.close();
  }
}

function clickHouseIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) {
    throw new Error(`Invalid ClickHouse identifier: ${name}`);
  }
  return `\`${name}\``;
}

function clickHouseClient(options = {}) {
  const endpoint = new URL(options.clickhouseUrl || DEFAULT_CLICKHOUSE_URL);
  const userFromUrl = decodeURIComponent(endpoint.username || "");
  const passwordFromUrl = decodeURIComponent(endpoint.password || "");
  endpoint.username = "";
  endpoint.password = "";
  return {
    url: endpoint.toString(),
    database: options.clickhouseDatabase || DEFAULT_CLICKHOUSE_DATABASE,
    user: options.clickhouseUser || userFromUrl,
    password: options.clickhousePassword || passwordFromUrl,
  };
}

function clickHouseLabel(client) {
  const endpoint = new URL(client.url);
  return `${endpoint.origin}/${client.database}`;
}

async function clickHouseRequest(client, query, { body = null, database = true, params = {}, settings = {} } = {}) {
  const url = new URL(client.url);
  if (database && client.database) url.searchParams.set("database", client.database);
  let requestBody = body;
  if (body === null && Buffer.byteLength(query) > 8 * 1024) {
    requestBody = query;
  } else {
    url.searchParams.set("query", query);
  }
  url.searchParams.set("output_format_json_quote_64bit_integers", "0");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, String(value ?? ""));
  }
  for (const [key, value] of Object.entries(settings)) {
    url.searchParams.set(key, String(value));
  }

  const headers = {};
  if (requestBody !== null) headers["content-type"] = "text/plain; charset=utf-8";
  if (client.user || client.password) {
    headers.authorization = `Basic ${Buffer.from(`${client.user}:${client.password}`).toString("base64")}`;
  }

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: requestBody });
  } catch (error) {
    const cause = error.cause?.message ? ` (${error.cause.message})` : "";
    throw new Error(`Cannot connect to ClickHouse at ${url.origin}. Start it with \`chctl local server start\`, or pass --clickhouse-url. ${error.message}${cause}`);
  }
  const text = await response.text();
  if (!response.ok) {
    const message = text.trim() || response.statusText;
    throw new Error(`ClickHouse query failed (${response.status}): ${message}`);
  }
  return text;
}

async function clickHouseJsonEachRow(client, query, options) {
  const text = await clickHouseRequest(client, `${query}\nFORMAT JSONEachRow`, options);
  return text.trim()
    ? text.trim().split("\n").map((line) => JSON.parse(line))
    : [];
}

async function initializeClickHouseDatabase(client) {
  await clickHouseRequest(
    client,
    `CREATE DATABASE IF NOT EXISTS ${clickHouseIdentifier(client.database)}`,
    { database: false },
  );
  await clickHouseRequest(client, `
    CREATE TABLE IF NOT EXISTS sources (
      source_path String CODEC(ZSTD(3)),
      kind LowCardinality(String) CODEC(ZSTD(1)),
      archive_path String CODEC(ZSTD(3)),
      entry_name String CODEC(ZSTD(3)),
      fingerprint String CODEC(ZSTD(3)),
      size_bytes UInt64 CODEC(Delta, ZSTD(1)),
      compressed_size_bytes UInt64 CODEC(Delta, ZSTD(1)),
      imported_at String CODEC(ZSTD(1))
    ) ENGINE = MergeTree
    ORDER BY source_path
  `);
  await clickHouseRequest(client, `
    CREATE TABLE IF NOT EXISTS codex_sessions (
      session_id String CODEC(ZSTD(3)),
      parent_session_id String CODEC(ZSTD(3)),
      source_path String CODEC(ZSTD(3)),
      kind LowCardinality(String) CODEC(ZSTD(1)),
      archive_path String CODEC(ZSTD(3)),
      entry_name String CODEC(ZSTD(3)),
      updated_at_ms UInt64 CODEC(Delta, ZSTD(1))
    ) ENGINE = ReplacingMergeTree(updated_at_ms)
    ORDER BY session_id
  `);
  await clickHouseRequest(client, `
    CREATE TABLE IF NOT EXISTS sessions (
      source_path String CODEC(ZSTD(3)),
      kind LowCardinality(String) CODEC(ZSTD(1)),
      archive_path String CODEC(ZSTD(3)),
      entry_name String CODEC(ZSTD(3)),
      size_bytes UInt64 CODEC(Delta, ZSTD(1)),
      compressed_size_bytes UInt64 CODEC(Delta, ZSTD(1)),
      started_at String CODEC(ZSTD(1)),
      finished_at String CODEC(ZSTD(1)),
      duration_ms Float64 CODEC(Gorilla, ZSTD(1)),
      lines UInt64 CODEC(Delta, ZSTD(1)),
      records UInt64 CODEC(Delta, ZSTD(1)),
      parse_errors UInt64 CODEC(Delta, ZSTD(1)),
      token_count_snapshots UInt64 CODEC(Delta, ZSTD(1)),
      skipped_token_count_snapshots UInt64 CODEC(Delta, ZSTD(1)),
      stats_json String CODEC(ZSTD(6))
    ) ENGINE = MergeTree
    ORDER BY source_path
  `);
  await clickHouseRequest(client, `
    CREATE TABLE IF NOT EXISTS usage_events (
      source_path String CODEC(ZSTD(3)),
      line_no UInt64 CODEC(Delta, ZSTD(1)),
      timestamp Nullable(String) CODEC(ZSTD(1)),
      date_key String CODEC(ZSTD(1)),
      week_key String CODEC(ZSTD(1)),
      month_key String CODEC(ZSTD(1)),
      year_key String CODEC(ZSTD(1)),
      provider LowCardinality(String) CODEC(ZSTD(1)),
      model String CODEC(ZSTD(3)),
      project String CODEC(ZSTD(3)),
      effort LowCardinality(String) CODEC(ZSTD(1)),
      input UInt64 CODEC(Delta, ZSTD(1)),
      cache_create_5m UInt64 CODEC(Delta, ZSTD(1)),
      cache_create_30m UInt64 CODEC(Delta, ZSTD(1)),
      cache_create_1h UInt64 CODEC(Delta, ZSTD(1)),
      cache_read UInt64 CODEC(Delta, ZSTD(1)),
      output UInt64 CODEC(Delta, ZSTD(1)),
      reasoning_output UInt64 CODEC(Delta, ZSTD(1)),
      context_window UInt64 CODEC(Delta, ZSTD(1)),
      priced UInt8 CODEC(T64, ZSTD(1)),
      cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
      reasoning_cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
      cost_input_usd Float64 CODEC(Gorilla, ZSTD(1)),
      cost_cache_create_5m_usd Float64 CODEC(Gorilla, ZSTD(1)),
      cost_cache_create_30m_usd Float64 CODEC(Gorilla, ZSTD(1)),
      cost_cache_create_1h_usd Float64 CODEC(Gorilla, ZSTD(1)),
      cost_cache_read_usd Float64 CODEC(Gorilla, ZSTD(1)),
      cost_output_usd Float64 CODEC(Gorilla, ZSTD(1)),
      visible_input_chars UInt64 CODEC(Delta, ZSTD(1)),
      visible_output_chars UInt64 CODEC(Delta, ZSTD(1)),
      visible_total_chars UInt64 CODEC(Delta, ZSTD(1)),
      visible_chars_per_token Float64 CODEC(Gorilla, ZSTD(1))
    ) ENGINE = MergeTree
    ORDER BY (date_key, source_path, line_no)
  `);
  await clickHouseRequest(client, `
    ALTER TABLE usage_events
      ADD COLUMN IF NOT EXISTS cache_create_30m UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
      ADD COLUMN IF NOT EXISTS cost_cache_create_30m_usd Float64 DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
      ADD COLUMN IF NOT EXISTS visible_input_chars UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
      ADD COLUMN IF NOT EXISTS visible_output_chars UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
      ADD COLUMN IF NOT EXISTS visible_total_chars UInt64 DEFAULT 0 CODEC(Delta, ZSTD(1)),
      ADD COLUMN IF NOT EXISTS visible_chars_per_token Float64 DEFAULT 0 CODEC(Gorilla, ZSTD(1))
  `);
  await clickHouseRequest(client, `
    CREATE TABLE IF NOT EXISTS output_char_metrics (
      source_path String CODEC(ZSTD(3)),
      turn_id String CODEC(ZSTD(3)),
      timestamp Nullable(String) CODEC(ZSTD(1)),
      date_key String CODEC(ZSTD(1)),
      week_key String CODEC(ZSTD(1)),
      month_key String CODEC(ZSTD(1)),
      year_key String CODEC(ZSTD(1)),
      provider LowCardinality(String) CODEC(ZSTD(1)),
      model String CODEC(ZSTD(3)),
      project String CODEC(ZSTD(3)),
      effort LowCardinality(String) CODEC(ZSTD(1)),
      visible_output_chars UInt64 CODEC(Delta, ZSTD(1)),
      visible_output_tokens UInt64 CODEC(Delta, ZSTD(1)),
      output_chars_per_token Float64 CODEC(Gorilla, ZSTD(1))
    ) ENGINE = MergeTree
    ORDER BY (date_key, source_path, turn_id)
  `);
  await clickHouseRequest(client, `
    CREATE TABLE IF NOT EXISTS rate_limit_samples (
      source_path String CODEC(ZSTD(3)),
      line_no UInt64 CODEC(Delta, ZSTD(1)),
      sample_key String CODEC(ZSTD(3)),
      group_key String CODEC(ZSTD(3)),
      sequence UInt64 CODEC(Delta, ZSTD(1)),
      timestamp_ms UInt64 CODEC(Delta, ZSTD(1)),
      date_key String CODEC(ZSTD(1)),
      week_key String CODEC(ZSTD(1)),
      limit_id Nullable(String) CODEC(ZSTD(3)),
      limit_name Nullable(String) CODEC(ZSTD(3)),
      plan_type Nullable(String) CODEC(ZSTD(1)),
      kind LowCardinality(String) CODEC(ZSTD(1)),
      window_minutes UInt64 CODEC(Delta, ZSTD(1)),
      used_percent Float64 CODEC(Gorilla, ZSTD(1)),
      resets_at UInt64 CODEC(Delta, ZSTD(1)),
      reached UInt8 CODEC(T64, ZSTD(1)),
      agent LowCardinality(String) CODEC(ZSTD(1)),
      effort LowCardinality(String) CODEC(ZSTD(1)),
      model String CODEC(ZSTD(3)),
      input UInt64 CODEC(Delta, ZSTD(1)),
      cache_read UInt64 CODEC(Delta, ZSTD(1)),
      output UInt64 CODEC(Delta, ZSTD(1)),
      reasoning_output UInt64 CODEC(Delta, ZSTD(1)),
      priced UInt8 CODEC(T64, ZSTD(1)),
      cost_usd Float64 CODEC(Gorilla, ZSTD(1)),
      reasoning_cost_usd Float64 CODEC(Gorilla, ZSTD(1))
    ) ENGINE = MergeTree
    ORDER BY (group_key, timestamp_ms, sequence, source_path, line_no)
  `);
}

async function resetClickHouseTables(client) {
  await clickHouseRequest(
    client,
    `CREATE DATABASE IF NOT EXISTS ${clickHouseIdentifier(client.database)}`,
    { database: false },
  );
  for (const table of ["rate_limit_samples", "output_char_metrics", "usage_events", "sessions", "codex_sessions", "sources"]) {
    await clickHouseRequest(client, `DROP TABLE IF EXISTS ${table}`);
  }
}

function clickHouseSourceRow(source, fingerprint) {
  return {
    source_path: source.path,
    kind: source.kind,
    archive_path: source.archivePath || "",
    entry_name: source.entryName || "",
    fingerprint,
    size_bytes: number(source.sizeBytes),
    compressed_size_bytes: number(source.compressedSizeBytes),
    imported_at: new Date().toISOString(),
  };
}

async function loadClickHouseCodexSessionHeaders(client) {
  return clickHouseJsonEachRow(client, `
    SELECT
      session_id,
      argMax(parent_session_id, updated_at_ms) AS parent_session_id,
      argMax(source_path, updated_at_ms) AS source_path,
      argMax(kind, updated_at_ms) AS kind,
      argMax(archive_path, updated_at_ms) AS archive_path,
      argMax(entry_name, updated_at_ms) AS entry_name
    FROM codex_sessions
    GROUP BY session_id
  `);
}

async function storeClickHouseCodexSessionHeaders(client, headers) {
  const rows = codexSessionStorageRows(headers).map((row) => ({
    session_id: row.sessionId,
    parent_session_id: row.parentSessionId || "",
    source_path: row.sourcePath,
    kind: row.kind,
    archive_path: row.archivePath || "",
    entry_name: row.entryName || "",
    updated_at_ms: Date.parse(row.updatedAt),
  }));
  await clickHouseInsertRows(client, "codex_sessions", rows);
}

function clickHouseSessionRow(session) {
  return {
    source_path: session.path,
    kind: session.kind,
    archive_path: session.archivePath || "",
    entry_name: session.entryName || "",
    size_bytes: number(session.sizeBytes),
    compressed_size_bytes: number(session.compressedSizeBytes),
    started_at: session.startedAt || "",
    finished_at: session.finishedAt || "",
    duration_ms: number(session.durationMs),
    lines: number(session.lines),
    records: number(session.records),
    parse_errors: number(session.parseErrors),
    token_count_snapshots: number(session.tokenCountSnapshots),
    skipped_token_count_snapshots: number(session.skippedTokenCountSnapshots),
    stats_json: JSON.stringify(session.stats),
  };
}

function clickHouseUsageEventRow(event, defaultSourcePath) {
  const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
  return {
    source_path: event.sourcePath || defaultSourcePath,
    line_no: number(event.lineNo),
    timestamp: event.timestamp || null,
    date_key: dateKey(timestamp),
    week_key: weekKey(timestamp),
    month_key: monthKey(timestamp),
    year_key: yearKey(timestamp),
    provider: event.provider,
    model: event.model,
    project: event.project,
    effort: event.effort,
    input: number(event.usage.input),
    cache_create_5m: number(event.usage.cacheCreate5m),
    cache_create_30m: number(event.usage.cacheCreate30m),
    cache_create_1h: number(event.usage.cacheCreate1h),
    cache_read: number(event.usage.cacheRead),
    output: number(event.usage.output),
    reasoning_output: number(event.usage.reasoningOutput),
    context_window: number(event.usage.contextWindow),
    priced: event.cost.known ? 1 : 0,
    cost_usd: number(event.cost.amount),
    reasoning_cost_usd: number(event.cost.reasoningAmount),
    cost_input_usd: number(event.cost.breakdown.input),
    cost_cache_create_5m_usd: number(event.cost.breakdown.cacheCreate5m),
    cost_cache_create_30m_usd: number(event.cost.breakdown.cacheCreate30m),
    cost_cache_create_1h_usd: number(event.cost.breakdown.cacheCreate1h),
    cost_cache_read_usd: number(event.cost.breakdown.cacheRead),
    cost_output_usd: number(event.cost.breakdown.output),
    visible_input_chars: number(event.visibleChars?.input),
    visible_output_chars: number(event.visibleChars?.output),
    visible_total_chars: number(event.visibleChars?.total),
    visible_chars_per_token: number(event.visibleChars?.charsPerToken),
  };
}

function clickHouseOutputCharMetricRow(event, defaultSourcePath) {
  const timestamp = event.timestamp ? new Date(event.timestamp) : new Date(NaN);
  return {
    source_path: event.sourcePath || defaultSourcePath,
    turn_id: event.turnId || "",
    timestamp: event.timestamp || null,
    date_key: dateKey(timestamp),
    week_key: weekKey(timestamp),
    month_key: monthKey(timestamp),
    year_key: yearKey(timestamp),
    provider: event.provider,
    model: event.model,
    project: event.project,
    effort: event.effort,
    visible_output_chars: number(event.visibleOutputChars),
    visible_output_tokens: number(event.visibleOutputTokens),
    output_chars_per_token: number(event.charsPerToken),
  };
}

function clickHouseRateLimitSampleRow(sample, defaultSourcePath) {
  const timestamp = new Date(sample.timestampMs);
  return {
    source_path: sample.sourcePath || defaultSourcePath,
    line_no: number(sample.lineNo),
    sample_key: sample.key,
    group_key: sample.groupKey,
    sequence: number(sample.sequence),
    timestamp_ms: number(sample.timestampMs),
    date_key: dateKey(timestamp),
    week_key: weekKey(timestamp),
    limit_id: sample.windowMeta.limitId || null,
    limit_name: sample.windowMeta.limitName || null,
    plan_type: sample.windowMeta.planType || null,
    kind: sample.windowMeta.kind,
    window_minutes: number(sample.windowMeta.windowMinutes),
    used_percent: number(sample.usedPercent),
    resets_at: number(sample.resetsAt),
    reached: sample.reached ? 1 : 0,
    agent: sample.agent,
    effort: sample.effort,
    model: sample.model,
    input: number(sample.usage.input),
    cache_read: number(sample.usage.cacheRead),
    output: number(sample.usage.output),
    reasoning_output: number(sample.usage.reasoningOutput),
    priced: sample.cost.known ? 1 : 0,
    cost_usd: number(sample.cost.amount),
    reasoning_cost_usd: number(sample.cost.reasoningAmount),
  };
}

function clickHouseInsertSettings(options = {}) {
  return {
    rows: options.clickhouseInsertBatchRows || DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS,
    bytes: options.clickhouseInsertBatchBytes || DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES,
  };
}

function createClickHouseRowSink(client, table, options = {}) {
  const limits = clickHouseInsertSettings(options);
  let lines = [];
  let bytes = 0;
  let pending = Promise.resolve();

  const flush = () => {
    if (lines.length === 0) return pending;
    const chunk = lines;
    lines = [];
    bytes = 0;
    pending = pending.then(() => clickHouseInsertLines(client, table, chunk));
    return pending;
  };

  return {
    push(row) {
      const line = JSON.stringify(row);
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
    },
    drainIfFull() {
      return lines.length >= limits.rows || bytes >= limits.bytes ? flush() : null;
    },
    finish() {
      return flush();
    },
  };
}

function drainClickHouseSinks(sinks) {
  const flushes = sinks
    .map((sink) => sink.drainIfFull())
    .filter(Boolean);
  return flushes.length ? Promise.all(flushes) : null;
}

async function processAndStoreClickHouseSource(client, source, fingerprint, options, replaceExisting = true) {
  if (replaceExisting) await deleteClickHouseSourceRows(client, source.path);

  const usageSink = createClickHouseRowSink(client, "usage_events", options);
  const outputCharMetricSink = createClickHouseRowSink(client, "output_char_metrics", options);
  const rateLimitSink = createClickHouseRowSink(client, "rate_limit_samples", options);
  const report = newReport();
  report._usageEventSink = (event) => usageSink.push(clickHouseUsageEventRow(event, source.path));
  report._outputCharMetricSink = (event) => outputCharMetricSink.push(clickHouseOutputCharMetricRow(event, source.path));
  report._rateLimitSampleSink = (sample) => rateLimitSink.push(clickHouseRateLimitSampleRow(sample, source.path));
  report._afterLine = () => drainClickHouseSinks([usageSink, outputCharMetricSink, rateLimitSink]);

  if (source.kind === "jsonl") {
    await processJsonlFile(source.path, report, options);
  } else if (source.kind === "zip-entry") {
    await processZipEntry(source.archivePath, source.entry, report, options);
  } else {
    throw new Error(`Unsupported ClickHouse source kind: ${source.kind}`);
  }

  await usageSink.finish();
  await outputCharMetricSink.finish();
  await rateLimitSink.finish();
  await clickHouseInsertRows(client, "sessions", report.sessions.map(clickHouseSessionRow));
  await clickHouseInsertRows(client, "sources", [clickHouseSourceRow(source, fingerprint)]);
  return report;
}

async function clickHouseInsertLines(client, table, lines) {
  if (lines.length === 0) return;
  const body = `${lines.join("\n")}\n`;
  await clickHouseRequest(client, `INSERT INTO ${table} FORMAT JSONEachRow`, { body });
}

async function clickHouseInsertRows(client, table, rows, options = {}) {
  const { rows: chunkSize } = clickHouseInsertSettings(options);
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    await clickHouseInsertLines(client, table, chunk.map((row) => JSON.stringify(row)));
  }
}

async function existingClickHouseSourceFingerprint(client, sourcePath) {
  const rows = await clickHouseJsonEachRow(client, `
    SELECT fingerprint
    FROM sources
    WHERE source_path = {source:String}
    LIMIT 1
  `, { params: { source: sourcePath } });
  return rows[0]?.fingerprint || null;
}

async function deleteClickHouseSourceRows(client, sourcePath) {
  for (const table of ["usage_events", "output_char_metrics", "rate_limit_samples", "sessions", "sources"]) {
    await clickHouseRequest(
      client,
      `ALTER TABLE ${table} DELETE WHERE source_path = {source:String}`,
      { params: { source: sourcePath }, settings: { mutations_sync: 1 } },
    );
  }
}

async function syncClickHouseJsonlSource(client, input, options) {
  const stat = await fsp.stat(input.path);
  const fingerprint = sourceFingerprint({
    kind: "jsonl",
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  });
  const existingFingerprint = await existingClickHouseSourceFingerprint(client, input.path);
  if (existingFingerprint === fingerprint) return false;

  const source = {
    kind: "jsonl",
    path: input.path,
    sizeBytes: stat.size,
  };
  await processAndStoreClickHouseSource(client, source, fingerprint, options, existingFingerprint !== null);
  return true;
}

async function syncClickHouseZipSource(client, input, options, limiter) {
  const stat = await fsp.stat(input.path);
  const entries = (await listZipEntries(input.path))
    .filter((entry) => entry.fileName.endsWith(".jsonl"))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
  logProgress(options, `[zip] ${input.path} size=${formatBytes(stat.size)} entries=${formatInt(entries.length)}`);

  let changed = 0;
  for (const entry of entries) {
    if (!limiter.take()) continue;
    const sourcePath = `${input.path}:${entry.fileName}`;
    const fingerprint = sourceFingerprint({
      kind: "zip-entry",
      archiveSize: stat.size,
      archiveMtimeMs: stat.mtimeMs,
      entry: entry.fileName,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      localHeaderOffset: entry.localHeaderOffset,
    });
    const existingFingerprint = await existingClickHouseSourceFingerprint(client, sourcePath);
    if (existingFingerprint === fingerprint) continue;

    const source = {
      kind: "zip-entry",
      path: sourcePath,
      archivePath: input.path,
      entryName: entry.fileName,
      sizeBytes: entry.uncompressedSize,
      compressedSizeBytes: entry.compressedSize,
      entry,
    };
    await processAndStoreClickHouseSource(client, source, fingerprint, options, existingFingerprint !== null);
    changed += 1;
  }
  return changed > 0;
}

function selectedDbEngine(options = {}) {
  return options.dbEngine || DEFAULT_DB_ENGINE;
}

function aggregateStatsFromRow(row) {
  return {
    requests: number(row.requests),
    input: number(row.input),
    cacheCreate5m: number(row.cacheCreate5m),
    cacheCreate30m: number(row.cacheCreate30m),
    cacheCreate1h: number(row.cacheCreate1h),
    cacheRead: number(row.cacheRead),
    output: number(row.output),
    reasoningOutput: number(row.reasoningOutput),
    costUsd: number(row.costUsd),
    reasoningCostUsd: number(row.reasoningCostUsd),
    costsUsd: {
      input: number(row.costInputUsd),
      cacheCreate5m: number(row.costCacheCreate5mUsd),
      cacheCreate30m: number(row.costCacheCreate30mUsd),
      cacheCreate1h: number(row.costCacheCreate1hUsd),
      cacheRead: number(row.costCacheReadUsd),
      output: number(row.costOutputUsd),
    },
    pricedRequests: number(row.pricedRequests),
    unpricedRequests: number(row.unpricedRequests),
    pricedInput: number(row.pricedInput),
    pricedCacheCreate5m: number(row.pricedCacheCreate5m),
    pricedCacheCreate30m: number(row.pricedCacheCreate30m),
    pricedCacheCreate1h: number(row.pricedCacheCreate1h),
    pricedCacheRead: number(row.pricedCacheRead),
    pricedOutput: number(row.pricedOutput),
    pricedReasoningOutput: number(row.pricedReasoningOutput),
    visibleInputChars: number(row.visibleInputChars),
    visibleOutputChars: number(row.visibleOutputChars),
    visibleTotalChars: number(row.visibleTotalChars),
    visibleCharTokenSamples: number(row.visibleCharTokenSamples),
    visibleCharsPerTokenSum: number(row.visibleCharsPerTokenSum),
    visibleCharsPerTokenMin: number(row.visibleCharTokenSamples) > 0 ? number(row.visibleCharsPerTokenMin) : null,
    visibleCharsPerTokenMax: number(row.visibleCharTokenSamples) > 0 ? number(row.visibleCharsPerTokenMax) : null,
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

function clickHouseStatsSelect(bucketName, key1Expr, key2Expr = "''", groupBy = "") {
  return `
    SELECT
      '${bucketName}' AS bucket,
      ${key1Expr} AS key1,
      ${key2Expr} AS key2,
      count() AS requests,
      sum(input) AS input,
      sum(cache_create_5m) AS cacheCreate5m,
      sum(cache_create_30m) AS cacheCreate30m,
      sum(cache_create_1h) AS cacheCreate1h,
      sum(cache_read) AS cacheRead,
      sum(output) AS output,
      sum(reasoning_output) AS reasoningOutput,
      sum(cost_usd) AS costUsd,
      sum(reasoning_cost_usd) AS reasoningCostUsd,
      sum(cost_input_usd) AS costInputUsd,
      sum(cost_cache_create_5m_usd) AS costCacheCreate5mUsd,
      sum(cost_cache_create_30m_usd) AS costCacheCreate30mUsd,
      sum(cost_cache_create_1h_usd) AS costCacheCreate1hUsd,
      sum(cost_cache_read_usd) AS costCacheReadUsd,
      sum(cost_output_usd) AS costOutputUsd,
      sum(priced) AS pricedRequests,
      count() - sum(priced) AS unpricedRequests,
      sumIf(usage_events.input, usage_events.priced = 1) AS pricedInput,
      sumIf(usage_events.cache_create_5m, usage_events.priced = 1) AS pricedCacheCreate5m,
      sumIf(usage_events.cache_create_30m, usage_events.priced = 1) AS pricedCacheCreate30m,
      sumIf(usage_events.cache_create_1h, usage_events.priced = 1) AS pricedCacheCreate1h,
      sumIf(usage_events.cache_read, usage_events.priced = 1) AS pricedCacheRead,
      sumIf(usage_events.output, usage_events.priced = 1) AS pricedOutput,
      sumIf(usage_events.reasoning_output, usage_events.priced = 1) AS pricedReasoningOutput,
      sum(visible_input_chars) AS visibleInputChars,
      sum(visible_output_chars) AS visibleOutputChars,
      sum(visible_total_chars) AS visibleTotalChars,
      countIf(visible_chars_per_token > 0) AS visibleCharTokenSamples,
      sumIf(visible_chars_per_token, visible_chars_per_token > 0) AS visibleCharsPerTokenSum,
      minIf(visible_chars_per_token, visible_chars_per_token > 0) AS visibleCharsPerTokenMin,
      maxIf(visible_chars_per_token, visible_chars_per_token > 0) AS visibleCharsPerTokenMax
    FROM usage_events
    ${groupBy}
  `;
}

async function applyClickHouseUsageStats(client, report) {
  const rows = await clickHouseJsonEachRow(client, [
    clickHouseStatsSelect("total", "''"),
    clickHouseStatsSelect("daily", "date_key", "''", "GROUP BY date_key"),
    clickHouseStatsSelect("weekly", "week_key", "''", "GROUP BY week_key"),
    clickHouseStatsSelect("monthly", "month_key", "''", "GROUP BY month_key"),
    clickHouseStatsSelect("yearly", "year_key", "''", "GROUP BY year_key"),
    clickHouseStatsSelect("providers", "provider", "''", "GROUP BY provider"),
    clickHouseStatsSelect("models", "model", "''", "GROUP BY model"),
    clickHouseStatsSelect("providerModels", "concat(provider, '/', model)", "''", "GROUP BY provider, model"),
    clickHouseStatsSelect("projects", "project", "''", "GROUP BY project"),
    clickHouseStatsSelect("projectDaily", "project", "date_key", "GROUP BY project, date_key"),
    clickHouseStatsSelect("projectModels", "project", "model", "GROUP BY project, model"),
    clickHouseStatsSelect("efforts", "effort", "''", "GROUP BY effort"),
    clickHouseStatsSelect("modelEfforts", "model", "effort", "GROUP BY model, effort"),
  ].join("\nUNION ALL\n"));

  for (const row of rows) {
    const stats = aggregateStatsFromRow(row);
    if (row.bucket === "total") report.total = stats;
    else if (row.bucket === "daily") report.daily[row.key1] = stats;
    else if (row.bucket === "weekly") report.weekly[row.key1] = stats;
    else if (row.bucket === "monthly") report.monthly[row.key1] = stats;
    else if (row.bucket === "yearly") report.yearly[row.key1] = stats;
    else if (row.bucket === "providers") report.providers[row.key1] = stats;
    else if (row.bucket === "models") report.models[row.key1] = stats;
    else if (row.bucket === "providerModels") report.providerModels[row.key1] = stats;
    else if (row.bucket === "projects") report.projects[row.key1] = stats;
    else if (row.bucket === "projectDaily") {
      report.projectDaily[row.key1] ??= {};
      report.projectDaily[row.key1][row.key2] = stats;
    }
    else if (row.bucket === "projectModels") {
      report.projectModels[row.key1] ??= {};
      report.projectModels[row.key1][row.key2] = stats;
    } else if (row.bucket === "efforts") report.efforts[row.key1] = stats;
    else if (row.bucket === "modelEfforts") {
      report.modelEfforts[row.key1] ??= {};
      report.modelEfforts[row.key1][row.key2] = stats;
    }
  }
}

function mergeOutputCharMetricStats(target, row) {
  target.visibleOutputTextChars += number(row.visibleOutputTextChars);
  target.visibleOutputTextTokens += number(row.visibleOutputTextTokens);
  target.outputCharTokenOutliers += number(row.outputCharTokenOutliers);
  const samples = number(row.outputCharTokenSamples);
  if (samples <= 0) return;
  target.outputCharTokenSamples += samples;
  target.outputCharsPerTokenSum += number(row.outputCharsPerTokenSum);
  const min = number(row.outputCharsPerTokenMin);
  const max = number(row.outputCharsPerTokenMax);
  target.outputCharsPerTokenMin = target.outputCharsPerTokenMin === null
    ? min
    : Math.min(target.outputCharsPerTokenMin, min);
  target.outputCharsPerTokenMax = target.outputCharsPerTokenMax === null
    ? max
    : Math.max(target.outputCharsPerTokenMax, max);
}

function clickHouseOutputCharStatsSelect(bucketName, key1Expr, key2Expr = "''", groupBy = "") {
  return `
    SELECT
      '${bucketName}' AS bucket,
      ${key1Expr} AS key1,
      ${key2Expr} AS key2,
      sumIf(visible_output_chars, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS visibleOutputTextChars,
      sumIf(visible_output_tokens, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS visibleOutputTextTokens,
      countIf(output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharTokenSamples,
      sumIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenSum,
      minIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenMin,
      maxIf(output_chars_per_token, output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharsPerTokenMax,
      countIf(output_chars_per_token > ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}) AS outputCharTokenOutliers
    FROM output_char_metrics
    ${groupBy}
  `;
}

function outputCharTargetForBucket(report, row) {
  if (row.bucket === "total") return report.total;
  if (row.bucket === "daily") return bucket(report.daily, row.key1);
  if (row.bucket === "weekly") return bucket(report.weekly, row.key1);
  if (row.bucket === "monthly") return bucket(report.monthly, row.key1);
  if (row.bucket === "yearly") return bucket(report.yearly, row.key1);
  if (row.bucket === "providers") return bucket(report.providers, row.key1);
  if (row.bucket === "models") return bucket(report.models, row.key1);
  if (row.bucket === "providerModels") return bucket(report.providerModels, row.key1);
  if (row.bucket === "projects") return bucket(report.projects, row.key1);
  if (row.bucket === "projectDaily") return nestedBucket(report.projectDaily, row.key1, row.key2);
  if (row.bucket === "projectModels") return nestedBucket(report.projectModels, row.key1, row.key2);
  if (row.bucket === "efforts") return bucket(report.efforts, row.key1);
  if (row.bucket === "modelEfforts") return nestedBucket(report.modelEfforts, row.key1, row.key2);
  return null;
}

async function applyClickHouseOutputCharMetrics(client, report) {
  const rows = await clickHouseJsonEachRow(client, [
    clickHouseOutputCharStatsSelect("total", "''"),
    clickHouseOutputCharStatsSelect("daily", "date_key", "''", "GROUP BY date_key"),
    clickHouseOutputCharStatsSelect("weekly", "week_key", "''", "GROUP BY week_key"),
    clickHouseOutputCharStatsSelect("monthly", "month_key", "''", "GROUP BY month_key"),
    clickHouseOutputCharStatsSelect("yearly", "year_key", "''", "GROUP BY year_key"),
    clickHouseOutputCharStatsSelect("providers", "provider", "''", "GROUP BY provider"),
    clickHouseOutputCharStatsSelect("models", "model", "''", "GROUP BY model"),
    clickHouseOutputCharStatsSelect("providerModels", "concat(provider, '/', model)", "''", "GROUP BY provider, model"),
    clickHouseOutputCharStatsSelect("projects", "project", "''", "GROUP BY project"),
    clickHouseOutputCharStatsSelect("projectDaily", "project", "date_key", "GROUP BY project, date_key"),
    clickHouseOutputCharStatsSelect("projectModels", "project", "model", "GROUP BY project, model"),
    clickHouseOutputCharStatsSelect("efforts", "effort", "''", "GROUP BY effort"),
    clickHouseOutputCharStatsSelect("modelEfforts", "model", "effort", "GROUP BY model, effort"),
  ].join("\nUNION ALL\n"));

  for (const row of rows) {
    const target = outputCharTargetForBucket(report, row);
    if (target) mergeOutputCharMetricStats(target, row);
  }
}

async function applyClickHouseOutputCharQuantiles(client, report) {
  const valid = `output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}`;
  const rows = await clickHouseJsonEachRow(client, `
    SELECT
      'total' AS bucket,
      '' AS effort,
      quantileTDigestIf(0.10)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP10,
      quantileTDigestIf(0.99)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP99
    FROM output_char_metrics
    UNION ALL
    SELECT
      'effort' AS bucket,
      effort,
      quantileTDigestIf(0.10)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP10,
      quantileTDigestIf(0.99)(output_chars_per_token, ${valid}) AS outputCharsPerTokenP99
    FROM output_char_metrics
    GROUP BY effort
  `);

  for (const row of rows) {
    const target = row.bucket === "total" ? report.total : bucket(report.efforts, row.effort);
    target.outputCharsPerTokenP10 = number(row.outputCharsPerTokenP10);
    target.outputCharsPerTokenP99 = number(row.outputCharsPerTokenP99);
  }
}

async function applyClickHouseSessions(client, report) {
  const rows = await clickHouseJsonEachRow(client, `
    SELECT
      kind, source_path, archive_path, entry_name, size_bytes, compressed_size_bytes,
      started_at, finished_at, duration_ms, lines, records, parse_errors,
      token_count_snapshots, skipped_token_count_snapshots, stats_json
    FROM sessions
    ORDER BY source_path
  `);
  for (const row of rows) {
    report.sessions.push({
      kind: row.kind,
      path: row.source_path,
      archivePath: row.archive_path || null,
      entryName: row.entry_name || null,
      sizeBytes: number(row.size_bytes),
      compressedSizeBytes: number(row.compressed_size_bytes),
      startedAt: row.started_at || null,
      finishedAt: row.finished_at || null,
      durationMs: number(row.duration_ms),
      lines: number(row.lines),
      records: number(row.records),
      parseErrors: number(row.parse_errors),
      tokenCountSnapshots: number(row.token_count_snapshots),
      skippedTokenCountSnapshots: number(row.skipped_token_count_snapshots),
      stats: parseStoredStats(row.stats_json),
    });
  }
}

async function applyClickHouseSources(client, report) {
  const rows = await clickHouseJsonEachRow(client, `
    SELECT
      countIf(kind = 'jsonl') AS files,
      countIf(kind = 'zip-entry') AS zipEntries,
      uniqExactIf(archive_path, kind = 'zip-entry' AND archive_path != '') AS zipFiles
    FROM sources
  `);
  const row = rows[0] || {};
  report.sources.files = number(row.files);
  report.sources.zipEntries = number(row.zipEntries);
  report.sources.zipFiles = number(row.zipFiles);
  report.sources.parseErrors = report.sessions.reduce((sum, session) => sum + number(session.parseErrors), 0);
  report.sources.tokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.tokenCountSnapshots), 0);
  report.sources.skippedTokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.skippedTokenCountSnapshots), 0);
}

async function applyClickHouseUnpricedModels(client, report) {
  const rows = await clickHouseJsonEachRow(client, `
    SELECT provider, model, count() AS requests
    FROM usage_events
    WHERE priced = 0
    GROUP BY provider, model
  `);
  for (const row of rows) {
    const key = `${row.provider}/${row.model}`;
    report.unpricedModels[key] = {
      provider: row.provider,
      model: row.model,
      requests: number(row.requests),
    };
  }
}

function clickHouseRateLimitCte() {
  return `
    WITH
    ordered AS (
      SELECT
        *,
        lagInFrame(toNullable(timestamp_ms), 1) OVER w AS previous_timestamp_ms,
        lagInFrame(toNullable(resets_at), 1) OVER w AS previous_resets_at,
        lagInFrame(toNullable(used_percent), 1) OVER w AS previous_used_percent
      FROM rate_limit_samples
      WINDOW w AS (
        PARTITION BY group_key
        ORDER BY timestamp_ms, sequence, source_path, line_no
        ROWS BETWEEN 1 PRECEDING AND 1 PRECEDING
      )
    ),
    marked AS (
      SELECT
        *,
        if(isNull(previous_timestamp_ms), 1, 0) AS is_first,
        ifNull(resets_at = previous_resets_at, 0) AS same_window,
        if(isNull(previous_timestamp_ms), 0, timestamp_ms - assumeNotNull(previous_timestamp_ms)) AS elapsed_ms,
        (
          isNull(previous_timestamp_ms) = 0
          AND ifNull(resets_at = previous_resets_at, 0)
          AND resets_at != 0
          AND used_percent < assumeNotNull(previous_used_percent)
        ) AS ignored_non_monotonic
      FROM ordered
    ),
    classified AS (
      SELECT
        *,
        (
          is_first = 0
          AND ignored_non_monotonic = 0
          AND (same_window = 0 OR used_percent < assumeNotNull(previous_used_percent))
        ) AS reset_event
      FROM marked
    ),
    deltas AS (
      SELECT
        *,
        if(
          is_first = 0
          AND ignored_non_monotonic = 0
          AND reset_event = 0
          AND used_percent > assumeNotNull(previous_used_percent),
          used_percent - assumeNotNull(previous_used_percent),
          0
        ) AS delta_percent
      FROM classified
    ),
    bucketed AS (
      SELECT 'windows' AS bucket_type, group_key AS bucket_key, '' AS period_type, '' AS period, * FROM deltas
      UNION ALL
      SELECT 'daily' AS bucket_type, concat(agent, '/', date_key, '/', sample_key) AS bucket_key, 'daily' AS period_type, date_key AS period, * FROM deltas
      UNION ALL
      SELECT 'weekly' AS bucket_type, concat(agent, '/', week_key, '/', sample_key) AS bucket_key, 'weekly' AS period_type, week_key AS period, * FROM deltas
    )
  `;
}

function rateLimitStatsFromAggregate(row) {
  const stats = newRateLimitStats({
    agent: row.agent || null,
    periodType: row.period_type || null,
    period: row.period || null,
    limitId: row.limit_id || null,
    limitName: row.limit_name || null,
    planType: row.plan_type || null,
    kind: row.kind || null,
    windowMinutes: number(row.window_minutes) || null,
  });
  stats.samples = number(row.samples);
  stats.increases = number(row.increases);
  stats.resets = number(row.resets);
  stats.ignoredNonMonotonic = number(row.ignoredNonMonotonic);
  stats.reached = number(row.reached);
  stats.percentUsedDelta = number(row.percentUsedDelta);
  stats.latestUsedPercent = row.latestUsedPercent == null ? null : number(row.latestUsedPercent);
  stats.latestRemainingPercent = stats.latestUsedPercent == null ? null : Math.max(0, 100 - stats.latestUsedPercent);
  stats.latestAt = row.latestAtMs ? new Date(number(row.latestAtMs)).toISOString() : null;
  stats.activeMs = number(row.activeMs);
  stats.resetGapMs = number(row.resetGapMs);
  stats.maxResetGapMs = number(row.maxResetGapMs);
  return stats;
}

function rateLimitAttributionFromAggregate(row) {
  const stats = newRateLimitAttribution();
  stats.samples = number(row.samples);
  stats.increases = number(row.increases);
  stats.percentUsedDelta = number(row.percentUsedDelta);
  stats.activeMs = number(row.activeMs);
  stats.input = number(row.input);
  stats.cacheRead = number(row.cacheRead);
  stats.output = number(row.output);
  stats.reasoningOutput = number(row.reasoningOutput);
  stats.costUsd = number(row.costUsd);
  stats.reasoningCostUsd = number(row.reasoningCostUsd);
  return stats;
}

async function applyClickHouseRateLimits(client, report) {
  report.rateLimits = { windows: {}, daily: {}, weekly: {} };
  const bucketRows = await clickHouseJsonEachRow(client, `
    ${clickHouseRateLimitCte()}
    SELECT
      bucket_type,
      bucket_key,
      any(agent) AS agent,
      any(period_type) AS period_type,
      any(period) AS period,
      any(limit_id) AS limit_id,
      any(limit_name) AS limit_name,
      any(plan_type) AS plan_type,
      any(kind) AS kind,
      any(window_minutes) AS window_minutes,
      count() AS samples,
      sum(reached) AS reached,
      sum(ignored_non_monotonic) AS ignoredNonMonotonic,
      sum(reset_event) AS resets,
      sum(delta_percent > 0) AS increases,
      sum(delta_percent) AS percentUsedDelta,
      sumIf(greatest(0, elapsed_ms), delta_percent > 0) AS activeMs,
      sumIf(elapsed_ms, reset_event AND elapsed_ms > 0) AS resetGapMs,
      maxIf(elapsed_ms, reset_event AND elapsed_ms > 0) AS maxResetGapMs,
      argMax(used_percent, tuple(timestamp_ms, sequence, source_path, line_no)) AS latestUsedPercent,
      max(timestamp_ms) AS latestAtMs
    FROM bucketed
    GROUP BY bucket_type, bucket_key
  `);
  for (const row of bucketRows) {
    report.rateLimits[row.bucket_type][row.bucket_key] = rateLimitStatsFromAggregate(row);
  }

  const attributionRows = await clickHouseJsonEachRow(client, `
    ${clickHouseRateLimitCte()}
    SELECT
      bucket_type,
      bucket_key,
      attr_type,
      attr_key1,
      attr_key2,
      count() AS samples,
      sum(delta_percent > 0) AS increases,
      sum(delta_percent) AS percentUsedDelta,
      sumIf(greatest(0, elapsed_ms), delta_percent > 0) AS activeMs,
      sumIf(input, delta_percent > 0) AS input,
      sumIf(cache_read, delta_percent > 0) AS cacheRead,
      sumIf(output, delta_percent > 0) AS output,
      sumIf(reasoning_output, delta_percent > 0) AS reasoningOutput,
      sumIf(cost_usd, delta_percent > 0) AS costUsd,
      sumIf(reasoning_cost_usd, delta_percent > 0) AS reasoningCostUsd
    FROM (
      SELECT bucket_type, bucket_key, 'effort' AS attr_type, effort AS attr_key1, '' AS attr_key2, * FROM bucketed
      UNION ALL
      SELECT bucket_type, bucket_key, 'model' AS attr_type, model AS attr_key1, '' AS attr_key2, * FROM bucketed
      UNION ALL
      SELECT bucket_type, bucket_key, 'model_effort' AS attr_type, model AS attr_key1, effort AS attr_key2, * FROM bucketed
    )
    GROUP BY bucket_type, bucket_key, attr_type, attr_key1, attr_key2
  `);
  for (const row of attributionRows) {
    const stats = report.rateLimits[row.bucket_type][row.bucket_key];
    if (!stats) continue;
    const attribution = rateLimitAttributionFromAggregate(row);
    if (row.attr_type === "effort") stats.byEffort[row.attr_key1] = attribution;
    else if (row.attr_type === "model") stats.byModel[row.attr_key1] = attribution;
    else if (row.attr_type === "model_effort") {
      stats.byModelEffort[row.attr_key1] ??= {};
      stats.byModelEffort[row.attr_key1][row.attr_key2] = attribution;
    }
  }
  report._rateLimitFinalized = true;
}

async function buildReportFromClickHouse(options = {}) {
  const client = clickHouseClient(options);
  await initializeClickHouseDatabase(client);
  const report = newReport();
  await applyClickHouseUsageStats(client, report);
  await applyClickHouseOutputCharMetrics(client, report);
  await applyClickHouseOutputCharQuantiles(client, report);
  await applyClickHouseSessions(client, report);
  await applyClickHouseSources(client, report);
  await applyClickHouseUnpricedModels(client, report);
  await applyClickHouseRateLimits(client, report);
  return report;
}

async function syncClickHouseDatabase(options) {
  const client = clickHouseClient(options);
  if (options.clickhouseReset) {
    await resetClickHouseTables(client);
    logProgress(options, `[clickhouse] reset tables in ${clickHouseLabel(client)}`);
  }
  await initializeClickHouseDatabase(client);
  const inputs = await discoverInputs(options);
  const persistedCodexSessionHeaders = [
    ...(options.persistedCodexSessionHeaders || []),
    ...await loadClickHouseCodexSessionHeaders(client),
  ];
  const processingOptions = await processingOptionsWithCodexForkRegistry({
    ...options,
    persistedCodexSessionHeaders,
  }, inputs);
  await storeClickHouseCodexSessionHeaders(client, processingOptions.codexForkRegistry?.currentHeaders);
  const limiter = createLimiter(options.limitFiles);
  let changed = 0;
  for (const input of inputs) {
    if (input.kind === "jsonl") {
      if (!limiter.take()) continue;
      if (await syncClickHouseJsonlSource(client, input, processingOptions)) changed += 1;
    } else if (input.kind === "zip") {
      if (await syncClickHouseZipSource(client, input, processingOptions, limiter)) changed += 1;
    }
  }
  const report = await buildReportFromClickHouse(options);
  logProgress(options, `[clickhouse] ${clickHouseLabel(client)} changed_sources=${formatInt(changed)} sessions=${formatInt(report.sessions.length)}`);
  return report;
}

async function syncDatabase(options) {
  if (selectedDbEngine(options) === "clickhouse") return syncClickHouseDatabase(options);
  return syncSqliteDatabase(options);
}

function addStoredUsage(report, row) {
  const timestamp = row.timestamp ? new Date(row.timestamp) : new Date(NaN);
  const usage = {
    input: number(row.input),
    cacheCreate5m: number(row.cache_create_5m),
    cacheCreate30m: number(row.cache_create_30m),
    cacheCreate1h: number(row.cache_create_1h),
    cacheRead: number(row.cache_read),
    output: number(row.output),
    reasoningOutput: number(row.reasoning_output),
    contextWindow: number(row.context_window),
  };
  const cost = {
    known: Boolean(row.priced),
    amount: number(row.cost_usd),
    reasoningAmount: number(row.reasoning_cost_usd),
    breakdown: {
      input: number(row.cost_input_usd),
      cacheCreate5m: number(row.cost_cache_create_5m_usd),
      cacheCreate30m: number(row.cost_cache_create_30m_usd),
      cacheCreate1h: number(row.cost_cache_create_1h_usd),
      cacheRead: number(row.cost_cache_read_usd),
      output: number(row.cost_output_usd),
    },
  };
  const visibleChars = normalizeVisibleChars({
    input: row.visible_input_chars,
    output: row.visible_output_chars,
    total: row.visible_total_chars,
    charsPerToken: row.visible_chars_per_token,
  });
  const provider = row.provider || "unknown";
  const model = row.model || UNKNOWN_MODEL;
  const project = row.project || UNKNOWN_PROJECT;
  const effort = normalizeEffort(row.effort);

  addToStats(report.total, usage, cost, visibleChars);
  addToStats(bucket(report.daily, dateKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.weekly, weekKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.monthly, monthKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.yearly, yearKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.providers, provider), usage, cost, visibleChars);
  addToStats(bucket(report.models, model), usage, cost, visibleChars);
  addToStats(bucket(report.providerModels, `${provider}/${model}`), usage, cost, visibleChars);
  addToStats(bucket(report.projects, project), usage, cost, visibleChars);
  addToStats(nestedBucket(report.projectDaily, project, dateKey(timestamp)), usage, cost, visibleChars);
  addToStats(nestedBucket(report.projectModels, project, model), usage, cost, visibleChars);
  addToStats(bucket(report.efforts, effort), usage, cost, visibleChars);
  addToStats(nestedBucket(report.modelEfforts, model, effort), usage, cost, visibleChars);

  if (!cost.known) {
    const key = `${provider}/${model}`;
    report.unpricedModels[key] ??= { provider, model, requests: 0 };
    report.unpricedModels[key].requests += 1;
  }
}

function addStoredOutputCharMetric(report, row) {
  addOutputCharTokenMetric(report, {
    sourcePath: row.source_path,
    turnId: row.turn_id,
    timestamp: row.timestamp ? new Date(row.timestamp) : new Date(NaN),
    provider: row.provider || "unknown",
    model: row.model || UNKNOWN_MODEL,
    project: row.project || UNKNOWN_PROJECT,
    effort: normalizeEffort(row.effort),
    visibleOutputChars: number(row.visible_output_chars),
    visibleOutputTokens: number(row.visible_output_tokens),
    charsPerToken: number(row.output_chars_per_token),
  });
}

function parseStoredStats(json) {
  try {
    const parsed = JSON.parse(json);
    return {
      ...newStats(),
      ...parsed,
      costsUsd: {
        ...newCostBreakdown(),
        ...(parsed.costsUsd || {}),
      },
    };
  } catch {
    return newStats();
  }
}

function storedRateLimitCurrent(row) {
  return {
    key: row.sample_key,
    groupKey: row.group_key,
    sequence: number(row.sequence),
    timestampMs: number(row.timestamp_ms),
    windowMeta: {
      limitId: row.limit_id,
      limitName: row.limit_name,
      planType: row.plan_type,
      kind: row.kind,
      windowMinutes: row.window_minutes,
    },
    usedPercent: number(row.used_percent),
    resetsAt: number(row.resets_at),
    reached: Boolean(row.reached),
    sourcePath: row.source_path,
    lineNo: row.line_no,
    agent: row.agent,
    effort: normalizeEffort(row.effort),
    model: row.model || UNKNOWN_MODEL,
    usage: {
      input: number(row.input),
      cacheCreate5m: 0,
      cacheCreate1h: 0,
      cacheRead: number(row.cache_read),
      output: number(row.output),
      reasoningOutput: number(row.reasoning_output),
      contextWindow: 0,
    },
    cost: {
      known: Boolean(row.priced),
      amount: number(row.cost_usd),
      reasoningAmount: number(row.reasoning_cost_usd),
    },
  };
}

function addStoredRateLimitSample(report, current, previous) {
  const groupKey = current.groupKey || current.key;
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

  if (!previous) return;

  if (current.timestampMs < previous.timestampMs) {
    for (const bucket of buckets) bucket.stats.outOfOrder += 1;
    return;
  }

  const sameWindow = current.resetsAt === previous.resetsAt;
  if (sameWindow && current.resetsAt !== 0 && current.usedPercent < previous.usedPercent) {
    for (const bucket of buckets) bucket.stats.ignoredNonMonotonic += 1;
    return;
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
    return;
  }

  const deltaPercent = current.usedPercent - previous.usedPercent;
  if (deltaPercent > 0) {
    addRateLimitDelta(buckets, deltaPercent, elapsedMs, current);
  }
}

function finalizeStoredRateLimits(db, report) {
  report.rateLimits = { windows: {}, daily: {}, weekly: {} };
  let previous = null;
  let previousGroup = null;

  for (const row of db.prepare("SELECT * FROM rate_limit_samples ORDER BY group_key, timestamp_ms, sequence, id").iterate()) {
    const current = storedRateLimitCurrent(row);
    const groupKey = current.groupKey || current.key;
    const sameGroup = groupKey === previousGroup;
    addStoredRateLimitSample(report, current, sameGroup ? previous : null);
    previous = current;
    previousGroup = groupKey;
  }
  report._rateLimitFinalized = true;
}

function applyStoredOutputCharQuantiles(db, report) {
  const valid = `output_chars_per_token > 0 AND output_chars_per_token <= ${MAX_VALID_OUTPUT_CHARS_PER_TOKEN}`;
  const effortRows = db.prepare(`
    WITH ranked AS (
      SELECT
        effort,
        output_chars_per_token AS ratio,
        row_number() OVER (PARTITION BY effort ORDER BY output_chars_per_token) AS rank,
        count(*) OVER (PARTITION BY effort) AS samples
      FROM output_char_metrics
      WHERE ${valid}
    )
    SELECT
      effort,
      min(CASE WHEN rank >= (samples + 9) / 10 THEN ratio END) AS p10,
      min(CASE WHEN rank >= (99 * samples + 99) / 100 THEN ratio END) AS p99
    FROM ranked
    GROUP BY effort
  `).all();
  for (const row of effortRows) {
    const target = bucket(report.efforts, row.effort);
    target.outputCharsPerTokenP10 = number(row.p10);
    target.outputCharsPerTokenP99 = number(row.p99);
  }

  const totalRow = db.prepare(`
    WITH ranked AS (
      SELECT
        output_chars_per_token AS ratio,
        row_number() OVER (ORDER BY output_chars_per_token) AS rank,
        count(*) OVER () AS samples
      FROM output_char_metrics
      WHERE ${valid}
    )
    SELECT
      min(CASE WHEN rank >= (samples + 9) / 10 THEN ratio END) AS p10,
      min(CASE WHEN rank >= (99 * samples + 99) / 100 THEN ratio END) AS p99
    FROM ranked
  `).get();
  report.total.outputCharsPerTokenP10 = number(totalRow?.p10);
  report.total.outputCharsPerTokenP99 = number(totalRow?.p99);
}

function buildReportFromOpenDatabase(db, options = {}) {
  const report = newReport();
  for (const row of db.prepare("SELECT * FROM usage_events ORDER BY timestamp, id").iterate()) {
    addStoredUsage(report, row);
  }
  for (const row of db.prepare("SELECT * FROM output_char_metrics ORDER BY timestamp, id").iterate()) {
    addStoredOutputCharMetric(report, row);
  }
  applyStoredOutputCharQuantiles(db, report);

  for (const row of db.prepare("SELECT * FROM sessions ORDER BY source_path").iterate()) {
    report.sessions.push({
      kind: row.kind,
      path: row.source_path,
      archivePath: row.archive_path,
      entryName: row.entry_name,
      sizeBytes: row.size_bytes,
      compressedSizeBytes: row.compressed_size_bytes,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: number(row.duration_ms),
      lines: number(row.lines),
      records: number(row.records),
      parseErrors: number(row.parse_errors),
      tokenCountSnapshots: number(row.token_count_snapshots),
      skippedTokenCountSnapshots: number(row.skipped_token_count_snapshots),
      stats: parseStoredStats(row.stats_json),
    });
  }

  const zipFiles = new Set();
  for (const row of db.prepare("SELECT kind, archive_path FROM sources").iterate()) {
    if (row.kind === "jsonl") report.sources.files += 1;
    if (row.kind === "zip-entry") {
      report.sources.zipEntries += 1;
      if (row.archive_path) zipFiles.add(row.archive_path);
    }
  }
  report.sources.zipFiles = zipFiles.size;
  report.sources.parseErrors = report.sessions.reduce((sum, session) => sum + number(session.parseErrors), 0);
  report.sources.tokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.tokenCountSnapshots), 0);
  report.sources.skippedTokenCountSnapshots = report.sessions.reduce((sum, session) => sum + number(session.skippedTokenCountSnapshots), 0);

  finalizeStoredRateLimits(db, report);
  return report;
}

function buildReportFromDatabase(dbPath, options = {}) {
  const db = openTokenomicsDatabase(resolveDbPath({ ...options, db: dbPath }));
  try {
    return buildReportFromOpenDatabase(db, options);
  } finally {
    db.close();
  }
}

function sendJson(response, value, status = 200) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendHtml(response, body, status = 200) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function buildReportFromSelectedDatabase(options) {
  if (selectedDbEngine(options) === "clickhouse") return buildReportFromClickHouse(options);
  return buildReportFromDatabase(options.db, options);
}

function createReportCache(options, initialReport = null) {
  let report = initialReport;
  let pending = null;
  return {
    async get() {
      if (report) return report;
      if (!pending) {
        pending = buildReportFromSelectedDatabase(options)
          .then((built) => {
            report = built;
            return built;
          })
          .finally(() => {
            pending = null;
          });
      }
      return pending;
    },
  };
}

async function handleWebRequest(request, response, options) {
  if (request.method !== "GET") {
    sendJson(response, { error: "method not allowed" }, 405);
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname === "/") {
      sendHtml(response, await dashboard.dashboardHtml());
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }

    const report = await options.reportCache.get();
    if (url.pathname === "/api/report") {
      sendJson(response, report);
    } else if (url.pathname === "/api/summary") {
      sendJson(response, dashboard.webSummary(report, options));
    } else if (url.pathname === "/api/sessions") {
      sendJson(response, report.sessions.slice().sort((a, b) => b.stats.costUsd - a.stats.costUsd));
    } else {
      sendJson(response, { error: "not found" }, 404);
    }
  } catch (error) {
    sendJson(response, { error: error.message }, 500);
  }
}

async function startWebServer(options) {
  const db = resolveDbPath(options);
  const serverOptions = {
    ...options,
    db,
    reportCache: options.reportCache || createReportCache({ ...options, db }, options.preloadedReport || null),
  };
  const server = http.createServer((request, response) => {
    handleWebRequest(request, response, serverOptions).catch((error) => {
      sendJson(response, { error: error.message }, 500);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function parseArgs(argv) {
  const options = {
    source: "all",
    includeArchives: true,
    home: os.homedir(),
    format: "text",
    limitFiles: Number.POSITIVE_INFINITY,
    top: 25,
    openaiContext: "auto",
    strictJson: false,
    output: null,
    db: null,
    dbEngine: process.env.TOKENOMICS_DB_ENGINE || DEFAULT_DB_ENGINE,
    clickhouseUrl: process.env.TOKENOMICS_CLICKHOUSE_URL || DEFAULT_CLICKHOUSE_URL,
    clickhouseDatabase: process.env.TOKENOMICS_CLICKHOUSE_DATABASE || DEFAULT_CLICKHOUSE_DATABASE,
    clickhouseUser: process.env.TOKENOMICS_CLICKHOUSE_USER || "",
    clickhousePassword: process.env.TOKENOMICS_CLICKHOUSE_PASSWORD || "",
    clickhouseInsertBatchRows: Number(process.env.TOKENOMICS_CLICKHOUSE_INSERT_BATCH_ROWS || DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS),
    clickhouseInsertBatchBytes: parseByteSize(
      process.env.TOKENOMICS_CLICKHOUSE_INSERT_BATCH_BYTES || DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES,
      "TOKENOMICS_CLICKHOUSE_INSERT_BATCH_BYTES",
    ),
    clickhouseReset: false,
    sync: false,
    webserver: false,
    webserverSync: true,
    host: "127.0.0.1",
    port: 8787,
    progress: true,
    progressExplicit: false,
    paths: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];

    if (arg === "--json") options.format = "json";
    else if (arg === "--strict-json") options.strictJson = true;
    else if (arg === "--no-archives") options.includeArchives = false;
    else if (arg === "--archives") options.includeArchives = true;
    else if (arg === "--source") options.source = next();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length);
    else if (arg === "--home") options.home = Path.resolve(next());
    else if (arg.startsWith("--home=")) options.home = Path.resolve(arg.slice("--home=".length));
    else if (arg === "--limit-files") options.limitFiles = Number(next());
    else if (arg.startsWith("--limit-files=")) options.limitFiles = Number(arg.slice("--limit-files=".length));
    else if (arg === "--top") options.top = Number(next());
    else if (arg.startsWith("--top=")) options.top = Number(arg.slice("--top=".length));
    else if (arg === "--format") options.format = next();
    else if (arg.startsWith("--format=")) options.format = arg.slice("--format=".length);
    else if (arg === "--output" || arg === "-o") options.output = Path.resolve(next());
    else if (arg.startsWith("--output=")) options.output = Path.resolve(arg.slice("--output=".length));
    else if (arg === "--db") options.db = Path.resolve(next());
    else if (arg.startsWith("--db=")) options.db = Path.resolve(arg.slice("--db=".length));
    else if (arg === "--db-engine") options.dbEngine = next();
    else if (arg.startsWith("--db-engine=")) options.dbEngine = arg.slice("--db-engine=".length);
    else if (arg === "--clickhouse-url") options.clickhouseUrl = next();
    else if (arg.startsWith("--clickhouse-url=")) options.clickhouseUrl = arg.slice("--clickhouse-url=".length);
    else if (arg === "--clickhouse-database") options.clickhouseDatabase = next();
    else if (arg.startsWith("--clickhouse-database=")) options.clickhouseDatabase = arg.slice("--clickhouse-database=".length);
    else if (arg === "--clickhouse-user") options.clickhouseUser = next();
    else if (arg.startsWith("--clickhouse-user=")) options.clickhouseUser = arg.slice("--clickhouse-user=".length);
    else if (arg === "--clickhouse-password") options.clickhousePassword = next();
    else if (arg.startsWith("--clickhouse-password=")) options.clickhousePassword = arg.slice("--clickhouse-password=".length);
    else if (arg === "--clickhouse-insert-batch-rows") options.clickhouseInsertBatchRows = Number(next());
    else if (arg.startsWith("--clickhouse-insert-batch-rows=")) options.clickhouseInsertBatchRows = Number(arg.slice("--clickhouse-insert-batch-rows=".length));
    else if (arg === "--clickhouse-insert-batch-bytes") options.clickhouseInsertBatchBytes = parseByteSize(next(), "--clickhouse-insert-batch-bytes");
    else if (arg.startsWith("--clickhouse-insert-batch-bytes=")) options.clickhouseInsertBatchBytes = parseByteSize(arg.slice("--clickhouse-insert-batch-bytes=".length), "--clickhouse-insert-batch-bytes");
    else if (arg === "--clickhouse-reset") options.clickhouseReset = true;
    else if (arg === "--sync") options.sync = true;
    else if (arg === "--webserver") options.webserver = true;
    else if (arg === "--host") options.host = next();
    else if (arg.startsWith("--host=")) options.host = arg.slice("--host=".length);
    else if (arg === "--port") options.port = Number(next());
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice("--port=".length));
    else if (arg === "--no-sync") {
      options.sync = false;
      options.webserverSync = false;
    }
    else if (arg === "--no-progress") {
      options.progress = false;
      options.progressExplicit = true;
    } else if (arg === "--progress") {
      options.progress = true;
      options.progressExplicit = true;
    }
    else if (arg === "--openai-context") options.openaiContext = next();
    else if (arg.startsWith("--openai-context=")) options.openaiContext = arg.slice("--openai-context=".length);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      options.paths.push(arg);
    }
  }

  if (!["all", "claude", "codex"].includes(options.source)) {
    throw new Error("--source must be all, claude, or codex");
  }
  if (!["auto", "short", "long"].includes(options.openaiContext)) {
    throw new Error("--openai-context must be auto, short, or long");
  }
  if (!["text", "json"].includes(options.format)) {
    throw new Error("--format must be text or json");
  }
  if (!["sqlite", "clickhouse"].includes(options.dbEngine)) {
    throw new Error("--db-engine must be sqlite or clickhouse");
  }
  try {
    new URL(options.clickhouseUrl);
  } catch {
    throw new Error("--clickhouse-url must be a valid URL");
  }
  if (!options.clickhouseDatabase || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.clickhouseDatabase)) {
    throw new Error("--clickhouse-database must be a non-empty ClickHouse identifier");
  }
  if (!Number.isInteger(options.clickhouseInsertBatchRows) || options.clickhouseInsertBatchRows <= 0) {
    throw new Error("--clickhouse-insert-batch-rows must be a positive integer");
  }
  if (!Number.isInteger(options.clickhouseInsertBatchBytes) || options.clickhouseInsertBatchBytes <= 0) {
    throw new Error("--clickhouse-insert-batch-bytes must be a positive byte size");
  }
  if (!Number.isFinite(options.top) || options.top <= 0) {
    throw new Error("--top must be a positive number");
  }
  if (Number.isNaN(options.limitFiles) || options.limitFiles <= 0) {
    throw new Error("--limit-files must be a positive number");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  if (options.output && options.format === "text") {
    const ext = Path.extname(options.output).toLowerCase();
    if (ext === ".json") options.format = "json";
  }
  if (!options.output && options.format === "json" && !options.progressExplicit) {
    options.progress = false;
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node app.js [options] [paths...]

Scans Claude Code and Codex JSONL sessions and estimates token costs.

Options:
  --source all|claude|codex       Source roots to scan when paths are omitted (default: all)
  --archives / --no-archives      Include Codex archived_sessions zip files (default: include)
  --home PATH                     Home directory for default roots (default: current user home)
  --openai-context auto|short|long OpenAI short/long context pricing mode (default: auto)
  --limit-files N                 Process at most N JSONL files or zip entries
  --top N                         Rows to show per section (default: 25)
  --format text|json              Final report format (default: text, or inferred from --output .json)
  -o, --output PATH               Write final report to a .txt or .json file
  --db PATH                       SQLite database path (default: ./tokenomics.sqlite for DB modes)
  --db-engine sqlite|clickhouse   Database backend for --sync/--webserver (default: sqlite)
  --clickhouse-url URL            ClickHouse HTTP endpoint (default: ${DEFAULT_CLICKHOUSE_URL})
  --clickhouse-database NAME      ClickHouse database name (default: ${DEFAULT_CLICKHOUSE_DATABASE})
  --clickhouse-user USER          ClickHouse user, or TOKENOMICS_CLICKHOUSE_USER
  --clickhouse-password PASSWORD  ClickHouse password, or TOKENOMICS_CLICKHOUSE_PASSWORD
  --clickhouse-insert-batch-rows N Max rows per ClickHouse INSERT (default: ${DEFAULT_CLICKHOUSE_INSERT_BATCH_ROWS})
  --clickhouse-insert-batch-bytes SIZE Max JSONEachRow body size per INSERT (default: ${formatBytes(DEFAULT_CLICKHOUSE_INSERT_BATCH_BYTES)})
  --clickhouse-reset              Drop tokenomics ClickHouse tables before --sync
  --sync                          Import changed sources into the selected database and report from it
  --webserver                     Serve a local browser dashboard from the selected database
  --host HOST                     Webserver host (default: 127.0.0.1)
  --port PORT                     Webserver port (default: 8787, use 0 for a random free port)
  --no-sync                       Do not sync before --webserver
  --progress / --no-progress      Print per-session progress to stdout (default: progress on)
  --json                          Print machine-readable report JSON
  --strict-json                   Fail on malformed JSONL lines
  -h, --help                      Show this help
`);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.webserver) {
    let preloadedReport = null;
    if (options.webserverSync) {
      preloadedReport = await syncDatabase(options);
    }
    const server = await startWebServer({ ...options, preloadedReport });
    const address = server.address();
    const host = address.address === "::" ? "localhost" : address.address;
    logProgress(options, `[webserver] http://${host}:${address.port}`);
    return server;
  }
  if (options.sync) {
    const report = await syncDatabase(options);
    await writeReport(report, options);
    return report;
  }
  if (selectedDbEngine(options) === "clickhouse") {
    const report = await buildReportFromClickHouse(options);
    await writeReport(report, options);
    return report;
  }
  const report = await buildReport(options);
  await writeReport(report, options);
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
  buildReportFromClickHouse,
  buildReportFromDatabase,
  buildReport,
  calculateCost,
  createLineProcessor,
  discoverInputs,
  finalizeRateLimits,
  main,
  newReport,
  parseArgs,
  processJsonlFile,
  processZipFile,
  renderReport,
  startWebServer,
  syncDatabase,
  usageFromClaudeUsage,
  usageFromCodexInfo,
  writeReport,
};
