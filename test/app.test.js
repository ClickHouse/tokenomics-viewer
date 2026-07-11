"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const Path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { dashboardHtml, webSummary } = require("../lib/dashboard");

const {
  addUsage,
  buildReportFromDatabase,
  buildReport,
  calculateCost,
  createLineProcessor,
  finalizeRateLimits,
  main,
  newReport,
  parseArgs,
  startWebServer,
  syncDatabase,
  usageFromCodexInfo,
} = require("../app");

function defaultOptions(extra = {}) {
  return {
    source: "all",
    includeArchives: true,
    home: os.homedir(),
    format: "text",
    limitFiles: Number.POSITIVE_INFINITY,
    top: 25,
    openaiContext: "short",
    output: null,
    db: null,
    webserver: false,
    host: "127.0.0.1",
    port: 0,
    progress: false,
    strictJson: false,
    paths: [],
    ...extra,
  };
}

function statsFixture(extra = {}) {
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
    costsUsd: {
      input: 0,
      cacheCreate5m: 0,
      cacheCreate30m: 0,
      cacheCreate1h: 0,
      cacheRead: 0,
      output: 0,
    },
    pricedRequests: 0,
    unpricedRequests: 0,
    ...extra,
  };
}

test("dashboard summary keeps daily buckets chronological for time-series charts", () => {
  const report = newReport();
  report.daily["2026-01-03"] = statsFixture({ input: 30, cacheRead: 5, output: 3, costUsd: 3 });
  report.daily["2026-01-01"] = statsFixture({ input: 10, cacheRead: 2, output: 1, costUsd: 1 });
  report.daily["2026-01-02"] = statsFixture({ input: 20, cacheRead: 3, output: 2, costUsd: 2 });

  const summary = webSummary(report, defaultOptions());

  assert.deepEqual(summary.daily.map((row) => row.name), ["2026-01-01", "2026-01-02", "2026-01-03"]);
});

test("dashboard summary exposes per-project daily buckets for the project selector", () => {
  const report = newReport();
  report.projects["/tmp/project-a"] = statsFixture({ costUsd: 5 });
  report.projects["/tmp/project-b"] = statsFixture({ costUsd: 12 });
  report.projectDaily["/tmp/project-a"] = {
    "2026-01-02": statsFixture({ input: 20, cacheRead: 4, output: 2, costUsd: 2 }),
    "2026-01-01": statsFixture({ input: 30, cacheRead: 6, output: 3, costUsd: 3 }),
  };
  report.projectDaily["/tmp/project-b"] = {
    "2026-01-03": statsFixture({ input: 120, cacheRead: 40, output: 10, costUsd: 12 }),
  };

  const summary = webSummary(report, defaultOptions({ top: 10 }));

  assert.deepEqual(summary.projectDaily.map((project) => project.name), ["/tmp/project-b", "/tmp/project-a"]);
  assert.deepEqual(summary.projectDaily[1].daily.map((row) => row.name), ["2026-01-01", "2026-01-02"]);
});

test("dashboard html renders daily and cost mix with the shared canvas chart", () => {
  const html = dashboardHtml();

  assert.match(html, /id="daily-token-canvas"/);
  assert.match(html, /id="daily-token-hover-legend"/);
  assert.match(html, /id="cost-mix-canvas"/);
  assert.match(html, /id="cost-mix-hover-legend"/);
  assert.match(html, /id="efficiency-table"/);
  assert.match(html, /Output chars\/token p10\/avg\/p99/);
  assert.match(html, /Total \$\/1M priced out/);
  assert.match(html, /Output \$\/1M priced out/);
  assert.match(html, /Avg \$\/priced request/);
  assert.match(html, /Input Tokens/);
  assert.match(html, /Cache Tokens/);
  assert.match(html, /Output Tokens/);
  assert.match(html, /formatTokenCount/);
  assert.match(html, /formatUsdCompact/);
  assert.doesNotMatch(html, /\$\/1M priced tokens/);
  assert.match(html, /renderEfficiency/);
  assert.match(html, /renderSharedMixChart/);
  assert.match(html, /bindSharedMixCanvas/);
  assert.match(html, /drawSharedMixNode/);
  assert.match(html, /tokenMix/);
  assert.match(html, /tokenScale/);
  assert.match(html, /Math\.log10/);
  assert.match(html, /drawCanvasCatmullRom/);
  assert.doesNotMatch(html, /id="daily-token-chart"/);
  assert.doesNotMatch(html, /svgEl\('/);
  assert.doesNotMatch(html, /document\.getElementById\('cost-mix'\)/);
});

test("dashboard html replaces sessions with a zoomable project canvas", () => {
  const html = dashboardHtml();

  assert.match(html, /id="project-select"/);
  assert.match(html, /id="project-cost-canvas"/);
  assert.match(html, /id="project-hover-legend"/);
  assert.match(html, /renderProjectDailyChart/);
  assert.match(html, /addEventListener\('wheel'/);
  assert.match(html, /zoomSharedChartAt/);
  assert.match(html, /drawSharedSelection/);
  assert.match(html, /bindSharedMixCanvas\(projectChart\)/);
  assert.match(html, /segmentShareText/);
  assert.match(html, /tokens \/ /);
  assert.match(html, /Cost Mix/);
  assert.match(html, /data-mix-mode="daily"/);
  assert.match(html, /data-mix-mode="weekly"/);
  assert.match(html, /data-mix-mode="monthly"/);
  assert.match(html, /data-mix-mode="models"/);
  assert.doesNotMatch(html, /<h2>Sessions<\/h2>/);
  assert.doesNotMatch(html, /fetch\('\/api\/sessions'\)/);
});

test("aggregates Claude by model, deduplicates requestId, and prices cache buckets", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "claude-fixture");
  const assistantLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-05T00:00:00.000Z",
    requestId: "req_duplicate",
    cwd: "/tmp/project-a",
    message: {
      model: "claude-opus-4-8",
      usage: {
        input_tokens: 1_000_000,
        cache_creation_input_tokens: 300_000,
        cache_read_input_tokens: 300_000,
        output_tokens: 400_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 100_000,
          ephemeral_1h_input_tokens: 200_000,
        },
        output_tokens_details: {
          thinking_tokens: 100_000,
        },
      },
    },
  });

  processLine(assistantLine, 1);
  processLine(assistantLine, 2);

  assert.equal(report.total.requests, 1);
  assert.equal(report.models["claude-opus-4-8"].requests, 1);
  assert.equal(report.projects["/tmp/project-a"].requests, 1);
  assert.equal(report.total.reasoningOutput, 100_000);
  assert.equal(report.total.reasoningCostUsd, 2.5);
  assert.equal(report.efforts["<unknown>"].reasoningOutput, 100_000);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 17.775);
  assert.deepEqual(roundCosts(report.total.costsUsd), {
    input: 5,
    cacheCreate5m: 0.625,
    cacheCreate30m: 0,
    cacheCreate1h: 2,
    cacheRead: 0.15,
    output: 10,
  });
});

test("aggregates Codex token_count by turn_context model and OpenAI cached input pricing", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-b", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { cwd: "/tmp/project-b", model: "gpt-5.5", effort: "high" },
  }), 2);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 1_000_000,
          cached_input_tokens: 100_000,
          output_tokens: 200_000,
          reasoning_output_tokens: 50_000,
        },
        model_context_window: 258_400,
      },
    },
  }), 3);

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 900_000);
  assert.equal(report.models["gpt-5.5"].cacheRead, 100_000);
  assert.equal(report.providers.openai.requests, 1);
  assert.equal(report.total.reasoningOutput, 50_000);
  assert.equal(report.total.reasoningCostUsd, 1.5);
  assert.equal(report.efforts.high.requests, 1);
  assert.equal(report.efforts.high.reasoningOutput, 50_000);
  assert.equal(report.modelEfforts["gpt-5.5"].high.reasoningCostUsd, 1.5);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 10.55);
  assert.deepEqual(roundCosts(report.total.costsUsd), {
    input: 4.5,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.05,
    output: 6,
  });
});

test("tracks approximate visible chars per Codex usage turn", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-visible-chars-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { cwd: "/tmp/project-chars", model: "gpt-5-codex", effort: "medium" },
  }), 1);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: { type: "user_message", message: "hello" },
  }), 2);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "world" }] },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:04.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 8, cached_input_tokens: 2, output_tokens: 2 },
        model_context_window: 128_000,
      },
    },
  }), 4);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:01:03.000Z",
    payload: { type: "function_call_output", output: "abcd" },
  }), 5);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:01:04.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 4, cached_input_tokens: 0, output_tokens: 4 },
        model_context_window: 128_000,
      },
    },
  }), 6);

  assert.equal(report.total.visibleInputChars, 9);
  assert.equal(report.total.visibleOutputChars, 5);
  assert.equal(report.total.visibleTotalChars, 14);
  assert.equal(report.total.visibleCharTokenSamples, 2);
  assert.equal(report.total.visibleCharsPerTokenMin, 0.5);
  assert.equal(report.total.visibleCharsPerTokenMax, 1);
  assert.equal(report.total.visibleCharsPerTokenSum, 1.5);
  assert.equal(report.efforts.medium.visibleCharTokenSamples, 2);
});

test("tracks output chars per token at Codex turn granularity", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-output-chars-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000001", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 1);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 },
        model_context_window: 128_000,
      },
    },
  }), 2);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcdefghij" }] },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:03.100Z",
    payload: { type: "agent_message", message: "abcdefghij" },
  }), 4);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:03.200Z",
    payload: { type: "function_call", name: "exec_command", arguments: "x".repeat(10_000) },
  }), 5);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:03.300Z",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "y".repeat(10_000) }] },
  }), 6);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:04.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 110, cached_input_tokens: 0, output_tokens: 6, reasoning_output_tokens: 0 },
        model_context_window: 128_000,
      },
    },
  }), 7);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:05.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcdefghijklmno" }] },
  }), 8);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:01:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000002", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 9);

  assert.equal(report.total.outputCharTokenSamples, 1);
  assert.equal(report.total.visibleOutputTextChars, 25);
  assert.equal(report.total.visibleOutputTextTokens, 10);
  assert.equal(report.total.outputCharsPerTokenMin, 2.5);
  assert.equal(report.total.outputCharsPerTokenMax, 2.5);
  assert.equal(report.total.outputCharsPerTokenSum, 2.5);
  assert.equal(report.total.outputCharTokenOutliers, 1);
});

test("tracks request-level output chars per token from matching token_count snapshots", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-output-chars-request-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000011", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 1);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcdefghij" }] },
  }), 2);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 },
        model_context_window: 128_000,
      },
    },
  }), 3);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:01:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000012", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 4);

  assert.equal(report.total.outputCharTokenSamples, 1);
  assert.equal(report.total.visibleOutputTextChars, 10);
  assert.equal(report.total.visibleOutputTextTokens, 5);
  assert.equal(report.total.outputCharsPerTokenMin, 2);
  assert.equal(report.total.outputCharsPerTokenMax, 2);
  assert.equal(report.total.outputCharsPerTokenSum, 2);
  assert.equal(report.total.outputCharTokenOutliers, 0);
});

test("tracks priced token denominators separately from unpriced usage", () => {
  const report = newReport();
  const options = defaultOptions();

  addUsage(report, {
    provider: "openai",
    model: "gpt-5-codex",
    project: "/tmp/project-priced",
    effort: "high",
    timestamp: new Date("2026-07-05T00:00:00.000Z"),
    usage: {
      input: 100,
      cacheCreate5m: 7,
      cacheCreate1h: 3,
      cacheRead: 50,
      output: 10,
      reasoningOutput: 4,
      inputIncludesCacheRead: false,
    },
  }, options);
  addUsage(report, {
    provider: "openai",
    model: "missing-model",
    project: "/tmp/project-priced",
    effort: "high",
    timestamp: new Date("2026-07-05T00:01:00.000Z"),
    usage: {
      input: 1000,
      cacheCreate5m: 70,
      cacheCreate1h: 30,
      cacheRead: 500,
      output: 100,
      reasoningOutput: 40,
    },
  }, options);

  assert.equal(report.efforts.high.requests, 2);
  assert.equal(report.efforts.high.pricedRequests, 1);
  assert.equal(report.efforts.high.output, 110);
  assert.equal(report.efforts.high.pricedInput, 100);
  assert.equal(report.efforts.high.pricedCacheCreate5m, 7);
  assert.equal(report.efforts.high.pricedCacheCreate1h, 3);
  assert.equal(report.efforts.high.pricedCacheRead, 50);
  assert.equal(report.efforts.high.pricedOutput, 10);
  assert.equal(report.efforts.high.pricedReasoningOutput, 4);
});

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

test("aggregates Codex token_count by total deltas and skips duplicate snapshots", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-delta-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-delta", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { cwd: "/tmp/project-delta", model: "gpt-5-codex" },
  }), 2);

  const firstInfo = {
    total_token_usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 100_000,
      output_tokens: 200_000,
      reasoning_output_tokens: 100_000,
      total_tokens: 1_200_000,
    },
    last_token_usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 100_000,
      output_tokens: 200_000,
      reasoning_output_tokens: 100_000,
      total_tokens: 1_200_000,
    },
    model_context_window: 128_000,
  };

  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: { type: "token_count", info: firstInfo },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: { type: "token_count", info: firstInfo },
  }), 4);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:04.000Z",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1_500_000,
          cached_input_tokens: 150_000,
          output_tokens: 250_000,
          reasoning_output_tokens: 120_000,
          total_tokens: 1_750_000,
        },
        last_token_usage: {
          input_tokens: 500_000,
          cached_input_tokens: 50_000,
          output_tokens: 50_000,
          reasoning_output_tokens: 20_000,
          total_tokens: 550_000,
        },
        model_context_window: 128_000,
      },
    },
  }), 5);

  assert.equal(report.sources.tokenCountSnapshots, 3);
  assert.equal(report.sources.skippedTokenCountSnapshots, 1);
  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 1_350_000);
  assert.equal(report.total.cacheRead, 150_000);
  assert.equal(report.total.output, 250_000);
  assert.equal(report.total.reasoningOutput, 120_000);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 4.20625);
  assert.deepEqual(roundCosts(report.total.costsUsd), {
    input: 1.6875,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.01875,
    output: 2.5,
  });
});

test("treats Codex total counter decreases as a fresh sequence", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-reset-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-05T00:00:00.000Z",
    payload: { cwd: "/tmp/project-reset", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { cwd: "/tmp/project-reset", model: "gpt-5-codex" },
  }), 2);

  const emitTokenCount = (lineNo, timestamp, total) => {
    processLine(JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: {
          total_token_usage: total,
          last_token_usage: total,
          model_context_window: 128_000,
        },
      },
    }), lineNo);
  };

  emitTokenCount(3, "2026-07-05T00:00:02.000Z", {
    input_tokens: 1_000_000,
    cached_input_tokens: 900_000,
    output_tokens: 10_000,
    total_tokens: 1_010_000,
  });
  emitTokenCount(4, "2026-07-05T00:00:03.000Z", {
    input_tokens: 100_000,
    cached_input_tokens: 90_000,
    output_tokens: 1_000,
    total_tokens: 101_000,
  });
  emitTokenCount(5, "2026-07-05T00:00:04.000Z", {
    input_tokens: 150_000,
    cached_input_tokens: 120_000,
    output_tokens: 2_000,
    total_tokens: 152_000,
  });

  assert.equal(report.sources.tokenCountSnapshots, 3);
  assert.equal(report.sources.skippedTokenCountSnapshots, 0);
  assert.equal(report.total.requests, 3);
  assert.equal(report.total.input, 140_000);
  assert.equal(report.total.cacheRead, 1_110_000);
  assert.equal(report.total.output, 13_000);
});

test("skips replayed parent transcript in forked Codex sessions", () => {
  const report = newReport();
  const parentSessionId = "019d39a3-df16-7c62-9614-4dcf15617287";
  const childSessionId = "019d4cf5-4803-7eb1-a490-19abc40e6a59";
  const parentTurnId = "019d39a7-67c2-7363-aa28-0b83b8639593";
  const childTurnId = "019d4cf5-4d1e-79e2-bbb1-686e38bb6ba7";
  const processLine = createLineProcessor(report, defaultOptions({
    codexForkRegistry: {
      tracesBySession: new Map([[parentSessionId, new Set([`turn:${parentTurnId}`])]]),
      replaySessions: new Set([childSessionId]),
    },
  }), "codex-fork-fixture");
  const parentInfo = {
    total_token_usage: {
      input_tokens: 9_000_000,
      cached_input_tokens: 8_000_000,
      output_tokens: 900_000,
    },
    last_token_usage: {
      input_tokens: 9_000_000,
      cached_input_tokens: 8_000_000,
      output_tokens: 900_000,
    },
    model_context_window: 128_000,
  };
  const childInfo = {
    total_token_usage: {
      input_tokens: 10_000_000,
      cached_input_tokens: 8_100_000,
      output_tokens: 1_100_000,
      reasoning_output_tokens: 50_000,
    },
    last_token_usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 100_000,
      output_tokens: 200_000,
      reasoning_output_tokens: 50_000,
    },
    model_context_window: 128_000,
  };

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-04-02T06:50:36.530Z",
    payload: {
      id: childSessionId,
      forked_from_id: parentSessionId,
      cwd: "/tmp/child-project",
      model_provider: "openai",
    },
  }), 1);
  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-04-02T06:50:36.531Z",
    payload: {
      id: parentSessionId,
      cwd: "/tmp/parent-project",
      model_provider: "openai",
    },
  }), 2);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-04-02T06:50:36.532Z",
    payload: { turn_id: parentTurnId, cwd: "/tmp/parent-project", model: "gpt-5.5", effort: "high" },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:36.533Z",
    payload: { type: "token_count", info: parentInfo },
  }), 4);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:36.534Z",
    payload: { type: "token_count", info: parentInfo },
  }), 5);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:37.727Z",
    payload: { type: "task_started", turn_id: childTurnId },
  }), 6);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-04-02T06:50:38.253Z",
    payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex", effort: "xhigh" },
  }), 7);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:38.507Z",
    payload: { type: "token_count", info: childInfo },
  }), 8);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:39.507Z",
    payload: { type: "token_count", info: childInfo },
  }), 9);

  assert.equal(report.sources.tokenCountSnapshots, 2);
  assert.equal(report.sources.skippedTokenCountSnapshots, 1);
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 900_000);
  assert.equal(report.total.cacheRead, 100_000);
  assert.equal(report.total.output, 200_000);
  assert.equal(report.total.reasoningOutput, 50_000);
  assert.equal(report.projects["/tmp/parent-project"], undefined);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
  assert.equal(report.models["gpt-5.5"], undefined);
  assert.equal(report.models["gpt-5-codex"].requests, 1);
  assert.equal(report.efforts.xhigh.requests, 1);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 3.1375);
});

test("skips parent traces replayed before their session metadata in a subagent log", () => {
  const report = newReport();
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "81f2c4e4-a0a3-483f-8540-7beb1572ff60";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";
  const processLine = createLineProcessor(report, defaultOptions({
    codexForkRegistry: {
      tracesBySession: new Map([[parentSessionId, new Set([
        `turn:${parentTurnId}`,
        "call:call_parent_patch",
      ])]]),
      replaySessions: new Set([childSessionId]),
    },
  }), "codex-fork-prefix-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-10T00:35:30.110Z",
    payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.1105Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 999_000, cached_input_tokens: 900_000, output_tokens: 99_000 },
        total_token_usage: { input_tokens: 999_000, cached_input_tokens: 900_000, output_tokens: 99_000 },
      },
    },
  }), 2);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.111Z",
    payload: { type: "task_started", turn_id: parentTurnId },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.112Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 10_000 },
        total_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 10_000 },
      },
    },
  }), 4);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.113Z",
    payload: { type: "patch_apply_end", turn_id: parentTurnId, call_id: "call_parent_patch" },
  }), 5);
  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-10T00:35:30.114Z",
    payload: { id: parentSessionId, cwd: "/tmp/parent-project", model_provider: "openai" },
  }), 6);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.115Z",
    payload: { type: "task_started", turn_id: childTurnId },
  }), 7);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-10T00:35:30.116Z",
    payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex", effort: "high" },
  }), 8);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.117Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
        total_token_usage: { input_tokens: 1_000_100, cached_input_tokens: 900_050, output_tokens: 10_020 },
      },
    },
  }), 9);

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 50);
  assert.equal(report.total.cacheRead, 50);
  assert.equal(report.total.output, 20);
  assert.equal(report.projects["/tmp/parent-project"], undefined);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
});

test("skips replayed parent traces in archived Codex ZIP sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-zip-test-"));
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "019f48d9-5000-7000-8000-000000000001";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";
  const parent = Path.join(tmp, "parent.jsonl");
  const child = Path.join(tmp, "child.jsonl");
  const zipPath = Path.join(tmp, "sessions.zip");

  fs.writeFileSync(parent, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-02T00:00:00.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-04-02T00:00:01.000Z", payload: { turn_id: parentTurnId, cwd: "/tmp/parent-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:00:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    "",
  ].join("\n"));
  fs.writeFileSync(child, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-02T00:01:00.000Z", payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:01.000Z", payload: { type: "task_started", turn_id: parentTurnId } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-02T00:01:03.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:04.000Z", payload: { type: "task_started", turn_id: childTurnId } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-04-02T00:01:05.000Z", payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:06.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 }, total_token_usage: { input_tokens: 150, cached_input_tokens: 135, output_tokens: 15 } } } }),
    "",
  ].join("\n"));
  execFileSync("zip", ["-q", zipPath, Path.basename(parent), Path.basename(child)], { cwd: tmp });

  const report = await buildReport(defaultOptions({ paths: [zipPath] }));
  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 15);
  assert.equal(report.total.cacheRead, 135);
  assert.equal(report.total.output, 15);
  assert.equal(report.projects["/tmp/parent-project"].requests, 1);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
});

test("prices current Codex model ids", () => {
  const cost = calculateCost("openai", "gpt-5-codex", {
    input: 1_000_000,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 100_000,
    output: 200_000,
    contextWindow: 258_400,
    inputIncludesCacheRead: false,
  }, new Date("2026-07-05T00:00:00.000Z"), defaultOptions());

  assert.equal(cost.known, true);
  assert.equal(Number(cost.amount.toFixed(6)), 3.2625);

  const versionedCost = calculateCost("openai", "gpt-5.1-2026-01-15", {
    input: 1_000_000,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 100_000,
    output: 200_000,
    contextWindow: 258_400,
    inputIncludesCacheRead: false,
  }, new Date("2026-07-05T00:00:00.000Z"), defaultOptions());

  assert.equal(versionedCost.known, true);
  assert.equal(Number(versionedCost.amount.toFixed(6)), 3.2625);

  const sparkCost = calculateCost("openai", "gpt-5.3-codex-spark", {
    input: 1_000_000,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    cacheRead: 100_000,
    output: 200_000,
    contextWindow: 258_400,
  }, new Date("2026-07-05T00:00:00.000Z"), defaultOptions());

  assert.equal(sparkCost.known, false);
});

test("prices GPT-5.6 legacy and explicit cache usage formats", () => {
  const legacyUsage = usageFromCodexInfo({
    last_token_usage: {
      input_tokens: 100_000,
      cached_input_tokens: 100_000,
      output_tokens: 100_000,
      reasoning_output_tokens: 0,
    },
    model_context_window: 1_050_000,
  }).usage;
  const legacyCost = calculateCost(
    "openai",
    "gpt-5.6-sol",
    legacyUsage,
    new Date("2026-07-10T00:00:00.000Z"),
    defaultOptions({ openaiContext: "auto" }),
  );

  assert.equal(legacyUsage.cacheCreate30m, 0);
  assert.equal(legacyUsage.input, 0);
  assert.equal(legacyUsage.cacheRead, 100_000);
  assert.equal(legacyUsage.inputIncludesCacheRead, false);
  assert.equal(Number(legacyCost.amount.toFixed(6)), 3.05);
  assert.deepEqual(roundCosts(legacyCost.breakdown), {
    input: 0,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.05,
    output: 3,
  });

  const explicitUsage = usageFromCodexInfo({
    last_token_usage: {
      input_tokens: 100_000,
      cache_creation_input_tokens: 200_000,
      cache_read_input_tokens: 300_000,
      output_tokens: 400_000,
      reasoning_output_tokens: 50_000,
    },
    model_context_window: 1_050_000,
  }).usage;
  const explicitCost = calculateCost(
    "openai",
    "gpt-5.6-sol",
    explicitUsage,
    new Date("2026-07-10T00:00:00.000Z"),
    defaultOptions({ openaiContext: "auto" }),
  );

  assert.equal(explicitUsage.cacheCreate30m, 200_000);
  assert.equal(explicitUsage.input, 100_000);
  assert.equal(explicitUsage.cacheRead, 300_000);
  assert.equal(explicitUsage.inputIncludesCacheRead, false);
  assert.equal(Number(explicitCost.amount.toFixed(6)), 21.8);
  assert.deepEqual(roundCosts(explicitCost.breakdown), {
    input: 1,
    cacheCreate5m: 0,
    cacheCreate30m: 2.5,
    cacheCreate1h: 0,
    cacheRead: 0.3,
    output: 18,
  });
});

test("normalizes Codex cache formats for long-context pricing and clamps malformed legacy cache", () => {
  const legacyNearThreshold = usageFromCodexInfo({
    last_token_usage: {
      input_tokens: 200_000,
      cached_input_tokens: 100_000,
      output_tokens: 0,
    },
    model_context_window: 1_050_000,
  }).usage;
  const explicitNearThreshold = usageFromCodexInfo({
    last_token_usage: {
      input_tokens: 200_000,
      cache_read_input_tokens: 100_000,
      output_tokens: 0,
    },
    model_context_window: 1_050_000,
  }).usage;
  const legacyCost = calculateCost(
    "openai",
    "gpt-5.6-sol",
    legacyNearThreshold,
    new Date("2026-07-10T00:00:00.000Z"),
    defaultOptions({ openaiContext: "auto" }),
  );
  const explicitCost = calculateCost(
    "openai",
    "gpt-5.6-sol",
    explicitNearThreshold,
    new Date("2026-07-10T00:00:00.000Z"),
    defaultOptions({ openaiContext: "auto" }),
  );

  assert.equal(legacyNearThreshold.input, 100_000);
  assert.equal(explicitNearThreshold.input, 200_000);
  assert.equal(Number(legacyCost.breakdown.input.toFixed(6)), 0.5);
  assert.equal(Number(explicitCost.breakdown.input.toFixed(6)), 2);

  const malformed = usageFromCodexInfo({
    last_token_usage: {
      input_tokens: 10,
      cached_input_tokens: 20,
      output_tokens: 1,
    },
  }).usage;
  assert.equal(malformed.input, 0);
  assert.equal(malformed.cacheRead, 20);

  const nullDetails = usageFromCodexInfo({
    last_token_usage: {
      input_tokens: 10,
      input_tokens_details: null,
      cached_input_tokens: 2,
      output_tokens: 1,
    },
  }).usage;
  assert.equal(nullDetails.input, 8);
  assert.equal(nullDetails.cacheRead, 2);
});

test("normalizes official nested Codex cache details and subtracts cumulative deltas", () => {
  const first = usageFromCodexInfo({
    total_token_usage: {
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 50_000 },
      output_tokens: 10_000,
    },
  });
  const second = usageFromCodexInfo({
    total_token_usage: {
      prompt_tokens: 1_500_000,
      prompt_tokens_details: { cached_tokens: 150_000, cache_write_tokens: 100_000 },
      output_tokens: 20_000,
    },
  }, first.totalUsage);

  assert.deepEqual({
    input: first.usage.input,
    cacheRead: first.usage.cacheRead,
    cacheCreate30m: first.usage.cacheCreate30m,
    output: first.usage.output,
  }, {
    input: 850_000,
    cacheRead: 100_000,
    cacheCreate30m: 50_000,
    output: 10_000,
  });
  assert.deepEqual({
    input: second.usage.input,
    cacheRead: second.usage.cacheRead,
    cacheCreate30m: second.usage.cacheCreate30m,
    output: second.usage.output,
  }, {
    input: 400_000,
    cacheRead: 50_000,
    cacheCreate30m: 50_000,
    output: 10_000,
  });
});

test("parseArgs keeps stdout JSON clean unless progress is explicit", () => {
  assert.equal(parseArgs(["--json"]).progress, false);
  assert.equal(parseArgs(["--json", "--progress"]).progress, true);

  const outputOptions = parseArgs(["--output", "report.json"]);
  assert.equal(outputOptions.format, "json");
  assert.equal(outputOptions.progress, true);
});

test("parseArgs accepts ClickHouse database backend options", () => {
  const options = parseArgs([
    "--db-engine", "clickhouse",
    "--clickhouse-url", "http://127.0.0.1:8123",
    "--clickhouse-database", "tokenomics_test",
    "--clickhouse-user", "default",
    "--clickhouse-password", "secret",
    "--clickhouse-insert-batch-rows", "12345",
    "--clickhouse-insert-batch-bytes", "8MiB",
    "--clickhouse-reset",
  ]);

  assert.equal(options.dbEngine, "clickhouse");
  assert.equal(options.clickhouseUrl, "http://127.0.0.1:8123");
  assert.equal(options.clickhouseDatabase, "tokenomics_test");
  assert.equal(options.clickhouseUser, "default");
  assert.equal(options.clickhousePassword, "secret");
  assert.equal(options.clickhouseInsertBatchRows, 12_345);
  assert.equal(options.clickhouseInsertBatchBytes, 8 * 1024 * 1024);
  assert.equal(options.clickhouseReset, true);
});

test("buildReport scans explicit JSONL path and zip archives", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-c", model: "gpt-5.4-mini" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const zipPath = Path.join(tmp, "sessions.zip");
  execFileSync("zip", ["-q", zipPath, "session.jsonl"], { cwd: tmp });

  const report = await buildReport(defaultOptions({ paths: [zipPath] }));
  assert.equal(report.sources.zipFiles, 1);
  assert.equal(report.sources.zipEntries, 1);
  assert.equal(report.models["gpt-5.4-mini"].requests, 1);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 5.25);
});

test("main writes final JSON report with per-session metrics", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-output-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const output = Path.join(tmp, "report.json");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-d", model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: 200_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const report = await main(["--no-progress", "--output", output, jsonl]);
  const written = JSON.parse(fs.readFileSync(output, "utf8"));

  assert.equal(report.sessions.length, 1);
  assert.equal(written.sessions.length, 1);
  assert.equal(written.sessions[0].path, jsonl);
  assert.equal(written.sessions[0].lines, 2);
  assert.equal(written.sessions[0].records, 2);
  assert.equal(written.sessions[0].stats.requests, 1);
  assert.equal(written.sessions[0].stats.input, 900_000);
  assert.equal(written.sessions[0].stats.cacheRead, 100_000);
  assert.equal(written.sessions[0].stats.output, 200_000);
  assert.equal(Number(written.sessions[0].stats.costUsd.toFixed(6)), 3.1375);
  assert.deepEqual(roundCosts(written.sessions[0].stats.costsUsd), {
    input: 1.125,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.0125,
    output: 2,
  });
  assert.ok(written.sessions[0].durationMs >= 0);
});

test("syncDatabase imports sources idempotently and replaces changed sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-db-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");

  const writeSession = (outputTokens) => fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-db", model: "gpt-5-codex", effort: "high" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: outputTokens,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  writeSession(200_000);
  const first = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const second = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));

  assert.equal(first.total.requests, 1);
  assert.equal(second.total.requests, 1);
  assert.equal(second.total.output, 200_000);
  assert.equal(second.sessions.length, 1);

  writeSession(300_000);
  const updated = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  assert.equal(updated.total.requests, 1);
  assert.equal(updated.total.output, 300_000);
  assert.equal(updated.sessions[0].stats.output, 300_000);

  const stored = new DatabaseSync(db);
  try {
    const usage = stored.prepare("SELECT input, cache_read FROM usage_events").get();
    assert.deepEqual({ ...usage }, { input: 900_000, cache_read: 100_000 });
  } finally {
    stored.close();
  }

  const fromDb = buildReportFromDatabase(db, defaultOptions());
  assert.equal(fromDb.total.requests, 1);
  assert.equal(fromDb.total.output, 300_000);
});

test("syncDatabase reuses persisted Codex parent metadata for a child-only import", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-db-test-"));
  const parent = Path.join(tmp, "parent.jsonl");
  const child = Path.join(tmp, "child.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "81f2c4e4-a0a3-483f-8540-7beb1572ff60";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";

  fs.writeFileSync(parent, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:00:00.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-07-09T20:00:01.000Z", payload: { turn_id: parentTurnId, cwd: "/tmp/parent-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:00:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    "",
  ].join("\n"));
  fs.writeFileSync(child, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:01:00.000Z", payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:00.500Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 }, total_token_usage: { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:01.000Z", payload: { type: "task_started", turn_id: parentTurnId } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:01:03.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:04.000Z", payload: { type: "task_started", turn_id: childTurnId } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-07-09T20:01:05.000Z", payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:06.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 }, total_token_usage: { input_tokens: 150, cached_input_tokens: 135, output_tokens: 15 } } } }),
    "",
  ].join("\n"));

  await syncDatabase(defaultOptions({ db, paths: [parent] }));
  const sqlite = new DatabaseSync(db);
  try {
    const storedParent = sqlite.prepare(`
      SELECT session_id, parent_session_id, source_path, kind
      FROM codex_sessions
      WHERE session_id = ?
    `).get(parentSessionId);
    assert.deepEqual({ ...storedParent }, {
      session_id: parentSessionId,
      parent_session_id: null,
      source_path: parent,
      kind: "jsonl",
    });
  } finally {
    sqlite.close();
  }
  const report = await syncDatabase(defaultOptions({ db, paths: [child] }));

  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 15);
  assert.equal(report.total.cacheRead, 135);
  assert.equal(report.total.output, 15);

  const updatedSqlite = new DatabaseSync(db);
  try {
    const storedChild = updatedSqlite.prepare(`
      SELECT parent_session_id, source_path
      FROM codex_sessions
      WHERE session_id = ?
    `).get(childSessionId);
    assert.deepEqual({ ...storedChild }, {
      parent_session_id: parentSessionId,
      source_path: child,
    });
  } finally {
    updatedSqlite.close();
  }
});

test("web server serves stored SQLite summary and sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-web-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-web", model: "gpt-5.4-mini", effort: "medium" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const server = await startWebServer(defaultOptions({ db, host: "127.0.0.1", port: 0 }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const summary = await fetch(`${base}/api/summary`).then((response) => response.json());
    assert.equal(summary.total.requests, 1);
    assert.equal(summary.total.output, 1_000_000);
    assert.equal(summary.topModels[0].name, "gpt-5.4-mini");

    const sessions = await fetch(`${base}/api/sessions`).then((response) => response.json());
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].path, jsonl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("web server reuses preloaded report without rebuilding the database", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-web-cache-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const db = Path.join(tmp, "tokenomics.sqlite");
  const missingDb = Path.join(tmp, "missing.sqlite");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-web-cache", model: "gpt-5.4-mini", effort: "medium" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const preloadedReport = await syncDatabase(defaultOptions({ db, paths: [jsonl] }));
  const server = await startWebServer(defaultOptions({
    db: missingDb,
    host: "127.0.0.1",
    port: 0,
    preloadedReport,
  }));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const [summary, sessions] = await Promise.all([
      fetch(`${base}/api/summary`).then((response) => response.json()),
      fetch(`${base}/api/sessions`).then((response) => response.json()),
    ]);
    assert.equal(summary.total.requests, 1);
    assert.equal(sessions[0].path, jsonl);
    assert.equal(fs.existsSync(missingDb), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("ClickHouse sync streams usage rows in bounded insert chunks", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-ch-stream-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const rows = 20_050;
  const sessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { id: sessionId, forked_from_id: parentSessionId, cwd: "/tmp/project-clickhouse-stream" },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-clickhouse-stream", model: "gpt-5.4-mini", effort: "medium" },
    }),
  ];
  for (let i = 0; i < rows; i += 1) {
    lines.push(JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            output_tokens: 1,
          },
          model_context_window: 128_000,
        },
      },
    }));
  }
  fs.writeFileSync(jsonl, `${lines.join("\n")}\n`);

  const inserts = {};
  const queries = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    let query = url.searchParams.get("query") || "";
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (!query && body.includes("FROM usage_events")) query = body;
      queries.push(query);
      if (query.startsWith("INSERT INTO ")) {
        const table = query.match(/^INSERT INTO ([a-z_]+)/)?.[1];
        inserts[table] ??= [];
        inserts[table].push({
          bytes: Buffer.byteLength(body),
          rows: body.trim() ? body.trim().split("\n").length : 0,
          body,
        });
      }

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      if (query.includes("FROM usage_events") && query.includes("UNION ALL")) {
        response.end(`${JSON.stringify({
          bucket: "total",
          key1: "",
          key2: "",
          requests: rows,
          input: rows,
          cacheCreate5m: 0,
          cacheCreate30m: 0,
          cacheCreate1h: 0,
          cacheRead: 0,
          output: rows,
          reasoningOutput: 0,
          costUsd: 0,
          reasoningCostUsd: 0,
          costInputUsd: 0,
          costCacheCreate5mUsd: 0,
          costCacheCreate30mUsd: 0,
          costCacheCreate1hUsd: 0,
          costCacheReadUsd: 0,
          costOutputUsd: 0,
          pricedRequests: rows,
          unpricedRequests: 0,
          pricedInput: rows,
          pricedCacheCreate5m: 0,
          pricedCacheCreate30m: 0,
          pricedCacheCreate1h: 0,
          pricedCacheRead: 0,
          pricedOutput: rows,
          pricedReasoningOutput: 0,
        })}\n`);
      } else if (query.includes("FROM sources") && query.includes("countIf")) {
        response.end('{"files":1,"zipEntries":0,"zipFiles":0}\n');
      } else {
        response.end("");
      }
    });
  });

  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolve()));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const report = await syncDatabase(defaultOptions({
      dbEngine: "clickhouse",
      clickhouseUrl: url,
      clickhouseDatabase: "tokenomics_stream_test",
      clickhouseInsertBatchRows: 100_000,
      clickhouseInsertBatchBytes: 64 * 1024,
      clickhouseReset: true,
      paths: [jsonl],
      progress: false,
    }));

    assert.equal(report.total.requests, rows);
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS rate_limit_samples"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS usage_events"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS codex_sessions"));
    assert.ok(queries.some((query) => query === "DROP TABLE IF EXISTS sources"));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS codex_sessions")
      && query.includes("ReplacingMergeTree")
      && query.includes("parent_session_id")
    )));
    assert.ok(queries.some((query) => (
      query.includes("CREATE TABLE IF NOT EXISTS usage_events")
      && query.includes("CODEC(ZSTD(3))")
      && query.includes("CODEC(Delta, ZSTD(1))")
      && query.includes("CODEC(Gorilla, ZSTD(1))")
    )));
    assert.equal(queries.some((query) => query.startsWith("ALTER TABLE ")), false);
    assert.equal(inserts.usage_events.reduce((sum, insert) => sum + insert.rows, 0), rows);
    assert.ok(inserts.usage_events.length > 1);
    assert.ok(inserts.usage_events.every((insert) => insert.rows <= 100_000));
    assert.ok(inserts.usage_events.every((insert) => insert.bytes <= 70 * 1024));
    assert.equal(inserts.codex_sessions.length, 1);
    const storedSession = JSON.parse(inserts.codex_sessions[0].body.trim());
    assert.equal(storedSession.session_id, sessionId);
    assert.equal(storedSession.parent_session_id, parentSessionId);
    assert.equal(storedSession.source_path, jsonl);
    assert.equal(storedSession.kind, "jsonl");
    assert.equal(storedSession.archive_path, "");
    assert.equal(storedSession.entry_name, "");
    assert.ok(Number.isInteger(storedSession.updated_at_ms));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function roundCosts(costs) {
  return Object.fromEntries(
    Object.entries(costs).map(([key, value]) => [key, Number(value.toFixed(6))]),
  );
}
