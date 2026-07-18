"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const rateLimits = require("../lib/core/rate-limits");
const reportModel = require("../lib/core/report-model");
const { createLineProcessor, finalizeRateLimits, newReport } = require("../app");
const { defaultOptions, simpleUsage } = require("./support/fixtures");

function addRateLimitSample(report, usedPercent, timestamp) {
  rateLimits.addRateLimitSnapshot(report, {
    limit_id: "core-test",
    primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1_800_000_000 },
  }, {
    agent: "codex",
    provider: "openai",
    model: "gpt-5-codex",
    effort: "high",
    timestamp: new Date(timestamp),
    usage: simpleUsage(100, 1),
    cost: { known: true, amount: 1, reasoningAmount: 0 },
  });
}

test("attributes Codex rate limit consumption by effort and window", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-rate-fixture");

  const emitTurn = (lineNo, timestamp, effort) => {
    processLine(JSON.stringify({
      type: "turn_context",
      timestamp,
      payload: { cwd: "/tmp/project-rate", model: "gpt-5-codex", effort },
    }), lineNo);
  };
  const emitTokenCount = (lineNo, timestamp, input, primaryUsed, secondaryUsed, primaryReset = 1_800_000_000) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: Math.floor(input / 2),
            output_tokens: 1_000,
            reasoning_output_tokens: 100,
          },
          model_context_window: 128_000,
        },
        rate_limits: {
          limit_id: "codex",
          limit_name: "Codex",
          plan_type: "pro",
          primary: { used_percent: primaryUsed, window_minutes: 300, resets_at: primaryReset },
          secondary: { used_percent: secondaryUsed, window_minutes: 10080, resets_at: 1_800_400_000 },
        },
      },
    }), lineNo);
  };

  emitTurn(1, "2026-07-05T00:00:00.000Z", "low");
  emitTokenCount(2, "2026-07-05T00:00:10.000Z", 10_000, 10, 20);
  emitTokenCount(3, "2026-07-05T00:10:10.000Z", 20_000, 15, 22);
  emitTurn(4, "2026-07-05T00:10:20.000Z", "high");
  emitTokenCount(5, "2026-07-05T00:20:10.000Z", 30_000, 30, 23);
  emitTokenCount(6, "2026-07-05T05:10:10.000Z", 40_000, 3, 24, 1_800_018_000);
  finalizeRateLimits(report);

  const primary = report.rateLimits.windows["codex/codex:primary_300m"];
  assert.equal(primary.agent, "codex");
  assert.equal(primary.samples, 4);
  assert.equal(primary.increases, 2);
  assert.equal(primary.resets, 1);
  assert.equal(primary.percentUsedDelta, 20);
  assert.equal(primary.byEffort.low.percentUsedDelta, 5);
  assert.equal(primary.byEffort.high.percentUsedDelta, 15);
  assert.equal(primary.byModelEffort["gpt-5-codex"].high.percentUsedDelta, 15);
  assert.equal(primary.latestUsedPercent, 3);
  assert.equal(primary.latestRemainingPercent, 97);

  const secondary = report.rateLimits.windows["codex/codex:secondary_10080m"];
  assert.equal(secondary.samples, 4);
  assert.equal(secondary.increases, 3);
  assert.equal(secondary.percentUsedDelta, 4);
  assert.equal(secondary.latestRemainingPercent, 76);
});

test("aggregates Codex rate limits by day and week agent buckets", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-rate-period-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-06T12:00:00.000Z",
    payload: { cwd: "/tmp/project-rate-period", model: "gpt-5-codex", effort: "xhigh" },
  }), 1);

  const emitTokenCount = (lineNo, timestamp, input, usedPercent) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: Math.floor(input / 2),
            output_tokens: 1_000,
          },
          model_context_window: 128_000,
        },
        rate_limits: {
          limit_id: "codex",
          limit_name: "Codex",
          primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1_800_000_000 },
        },
      },
    }), lineNo);
  };

  emitTokenCount(2, "2026-07-06T12:05:00.000Z", 10_000, 20);
  emitTokenCount(3, "2026-07-06T12:15:00.000Z", 20_000, 35);
  finalizeRateLimits(report);

  const daily = report.rateLimits.daily["codex/2026-07-06/codex:primary_300m"];
  assert.equal(daily.agent, "codex");
  assert.equal(daily.period, "2026-07-06");
  assert.equal(daily.samples, 2);
  assert.equal(daily.percentUsedDelta, 15);
  assert.equal(daily.byEffort.xhigh.percentUsedDelta, 15);

  const weekly = report.rateLimits.weekly["codex/2026-W28/codex:primary_300m"];
  assert.equal(weekly.agent, "codex");
  assert.equal(weekly.period, "2026-W28");
  assert.equal(weekly.percentUsedDelta, 15);
});

test("sorts Codex rate limit snapshots before calculating deltas", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-rate-order-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-rate-order", model: "gpt-5-codex", effort: "high" },
  }), 1);

  const emitTokenCount = (lineNo, timestamp, usedPercent) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 10_000,
            cached_input_tokens: 5_000,
            output_tokens: 500,
          },
          model_context_window: 128_000,
        },
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: usedPercent, window_minutes: 300, resets_at: 1_800_000_000 },
        },
      },
    }), lineNo);
  };

  emitTokenCount(2, "2026-07-05T00:00:10.000Z", 10);
  emitTokenCount(3, "2026-07-05T00:20:10.000Z", 25);
  emitTokenCount(4, "2026-07-05T00:10:10.000Z", 20);
  finalizeRateLimits(report);

  const primary = report.rateLimits.windows["codex/codex:primary_300m"];
  assert.equal(primary.samples, 3);
  assert.equal(primary.increases, 2);
  assert.equal(primary.outOfOrder, 0);
  assert.equal(primary.resets, 0);
  assert.equal(primary.percentUsedDelta, 15);
});

test("rate-limit finalization ignores same-window non-monotonic samples", () => {
  const report = reportModel.newReport();
  addRateLimitSample(report, 10, "2026-07-10T00:00:00.000Z");
  addRateLimitSample(report, 20, "2026-07-10T01:00:00.000Z");
  addRateLimitSample(report, 15, "2026-07-10T02:00:00.000Z");

  rateLimits.finalizeRateLimits(report);
  const stats = report.rateLimits.windows["codex/core-test:primary_300m"];
  assert.equal(stats.samples, 3);
  assert.equal(stats.increases, 1);
  assert.equal(stats.percentUsedDelta, 10);
  assert.equal(stats.ignoredNonMonotonic, 1);
  assert.equal(stats.latestUsedPercent, 20);
  assert.equal(stats.latestAt, "2026-07-10T01:00:00.000Z");
});

test("rate-limit reset timestamps tolerate provider jitter", () => {
  const report = reportModel.newReport();
  const add = (usedPercent, timestamp, resetsAt) => {
    rateLimits.addRateLimitSnapshot(report, {
      limit_id: "jitter-test",
      primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt },
    }, {
      agent: "codex",
      provider: "openai",
      model: "gpt-5.6-sol",
      effort: "high",
      timestamp: new Date(timestamp),
      usage: simpleUsage(100, 1),
      cost: { known: true, amount: 1, reasoningAmount: 0 },
    });
  };

  add(44, "2026-07-17T05:00:00.000Z", 1_784_780_146);
  add(45, "2026-07-17T06:00:00.000Z", 1_784_780_149);
  add(46, "2026-07-17T07:00:00.000Z", 1_784_780_150);
  rateLimits.finalizeRateLimits(report);

  const stats = report.rateLimits.windows["codex/jitter-test:primary_10080m"];
  assert.equal(stats.resets, 0);
  assert.equal(stats.percentUsedDelta, 2);
  assert.equal(stats.latestResetAt, 1_784_780_150);
});

test("rate-limit finalization is idempotent", () => {
  const report = reportModel.newReport();
  addRateLimitSample(report, 10, "2026-07-10T00:00:00.000Z");
  addRateLimitSample(report, 20, "2026-07-10T01:00:00.000Z");

  rateLimits.finalizeRateLimits(report);
  const first = structuredClone(report.rateLimits);
  rateLimits.finalizeRateLimits(report);
  assert.deepEqual(report.rateLimits, first);
});
