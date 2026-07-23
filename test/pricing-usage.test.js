"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const pricing = require("../lib/core/pricing");
const usage = require("../lib/core/usage");
const reportModel = require("../lib/core/report-model");
const aggregate = require("../lib/core/aggregate");
const pricingOptions = { openaiContext: "auto" };
const {
  addUsage,
  calculateCost,
  createLineProcessor,
  newReport,
  usageFromCodexInfo,
} = require("../app");
const { defaultOptions, roundCosts, simpleUsage } = require("./support/fixtures");

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

test("captures provider telemetry without retaining conversation content", () => {
  const report = newReport();
  const telemetry = [];
  report._telemetryEventSink = (event) => telemetry.push(event);
  const processLine = createLineProcessor(report, defaultOptions(), "claude-telemetry-fixture");
  const usageLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-29T11:30:55.738Z",
    requestId: "req_telemetry",
    cwd: "/tmp/telemetry",
    message: {
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "private conversation text" }],
      usage: { input_tokens: 2, cache_read_input_tokens: 100, output_tokens: 5, service_tier: "standard" },
    },
  });
  processLine(usageLine, 1);
  processLine(usageLine, 2);
  processLine(JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-06T21:14:14.540Z",
    error: "rate_limit",
    apiErrorStatus: 429,
    version: "2.1.201",
    cwd: "/tmp/telemetry",
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: "You've hit your session limit · resets 5:40pm" }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }), 3);

  assert.equal(telemetry.length, 3);
  assert.equal(telemetry[0].eventKind, "usage_snapshot");
  assert.equal(JSON.parse(telemetry[0].rawJson).service_tier, "standard");
  assert.doesNotMatch(telemetry[0].rawJson, /private conversation text/);
  assert.equal(telemetry[1].eventKind, "usage_snapshot");
  assert.equal(telemetry[2].eventKind, "rate_limit_error");
  assert.equal(report.total.requests, 1, "raw duplicates must not change usage projections");
  assert.equal(report.providerLimitEvents.length, 1);
  assert.match(report.providerLimitEvents[0].message, /session limit/);
});

test("does not misclassify a Codex rate-limit error as an Anthropic limit anchor", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-error-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-18T10:00:00.000Z",
    payload: { cwd: "/tmp/codex", model_provider: "openai", model: "gpt-5.6-sol" },
  }), 1);
  processLine(JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-18T10:00:01.000Z",
    error: "rate_limit",
    message: { model: "gpt-5.6-sol", usage: { input_tokens: 0, output_tokens: 0 }, content: [] },
  }), 2);

  assert.deepEqual(report.providerLimitEvents, []);
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
  const localDay = reportModel.dateKey(new Date("2026-07-05T00:00:02.000Z"));
  assert.equal(report.providerModelEffortDaily.openai["gpt-5.5"].high[localDay].requests, 1);
  assert.equal(report.providerModelEffortDaily.openai["gpt-5.5"].high[localDay].cacheRead, 100_000);
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
  assert.equal(report.total.visibleOutputTextChars, 10);
  assert.equal(report.total.visibleOutputTextTokens, 6);
  assert.equal(report.total.outputCharsPerTokenMin, 10 / 6);
  assert.equal(report.total.outputCharsPerTokenMax, 10 / 6);
  assert.equal(report.total.outputCharsPerTokenSum, 10 / 6);
  assert.equal(report.total.outputCharTokenOutliers, 0);
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

test("falls back to agent_message text when response_item text is unavailable", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-agent-message-fallback-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000031", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 1);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 4 } },
    },
  }), 2);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: { type: "agent_message", message: "abcdefgh" },
  }), 3);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:01:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000032", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 4);

  assert.equal(report.total.outputCharTokenSamples, 1);
  assert.equal(report.total.visibleOutputTextChars, 8);
  assert.equal(report.total.visibleOutputTextTokens, 4);
  assert.equal(report.total.outputCharsPerTokenMin, 2);
  assert.equal(report.total.outputCharsPerTokenMax, 2);
  assert.equal(report.total.outputCharsPerTokenSum, 2);
});

test("does not reintroduce an excluded output chars-per-token request through turn fallback", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-output-char-excluded-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000041", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 1);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(11) }] },
  }), 2);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 1 } },
    },
  }), 3);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:01:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000042", cwd: "/tmp/project-output-chars", model: "gpt-5-codex", effort: "high" },
  }), 4);

  assert.equal(report.total.outputCharTokenSamples, 0);
  assert.equal(report.total.outputCharTokenOutliers, 0);
  assert.equal(report._outputCharMetrics.length, 0);
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

test("keeps cumulative deltas stable when Codex adds cache_write_input_tokens", () => {
  const previous = usageFromCodexInfo({
    total_token_usage: {
      input_tokens: 523_649_941,
      cached_input_tokens: 506_385_152,
      output_tokens: 1_275_974,
      total_tokens: 524_925_915,
    },
  });
  const transitioned = usageFromCodexInfo({
    total_token_usage: {
      input_tokens: 523_844_053,
      cached_input_tokens: 506_391_040,
      cache_write_input_tokens: 0,
      output_tokens: 1_277_045,
      total_tokens: 525_121_098,
    },
    last_token_usage: {
      input_tokens: 194_112,
      cached_input_tokens: 5_888,
      cache_write_input_tokens: 0,
      output_tokens: 1_071,
      total_tokens: 195_183,
    },
  }, previous.totalUsage);

  assert.deepEqual({
    input: transitioned.usage.input,
    cacheRead: transitioned.usage.cacheRead,
    cacheCreate30m: transitioned.usage.cacheCreate30m,
    output: transitioned.usage.output,
    sequenceReset: transitioned.usage.sequenceReset || false,
  }, {
    input: 188_224,
    cacheRead: 5_888,
    cacheCreate30m: 0,
    output: 1_071,
    sequenceReset: false,
  });

  const next = usageFromCodexInfo({
    total_token_usage: {
      input_tokens: 524_069_731,
      cached_input_tokens: 506_604_800,
      cache_write_input_tokens: 0,
      output_tokens: 1_277_358,
      total_tokens: 525_347_089,
    },
    last_token_usage: {
      input_tokens: 225_678,
      cached_input_tokens: 213_760,
      cache_write_input_tokens: 0,
      output_tokens: 313,
      total_tokens: 225_991,
    },
  }, transitioned.totalUsage);

  assert.deepEqual({
    input: next.usage.input,
    cacheRead: next.usage.cacheRead,
    output: next.usage.output,
  }, {
    input: 11_918,
    cacheRead: 213_760,
    output: 313,
  });
});

test("subtracts Codex cache write and read buckets when total_tokens includes them", () => {
  const normalized = usage.usageFromCodexTokenUsage({
    input_tokens: 200_000,
    cached_input_tokens: 40_000,
    cache_write_input_tokens: 10_000,
    output_tokens: 5_000,
    total_tokens: 205_000,
  });

  assert.deepEqual({
    input: normalized.input,
    cacheRead: normalized.cacheRead,
    cacheCreate30m: normalized.cacheCreate30m,
    output: normalized.output,
  }, {
    input: 150_000,
    cacheRead: 40_000,
    cacheCreate30m: 10_000,
    output: 5_000,
  });
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
  assert.equal(report.total.input, 130_000);
  assert.equal(report.total.cacheRead, 1_020_000);
  assert.equal(report.total.output, 12_000);
});

test("OpenAI auto pricing changes variant only above the 272k threshold", () => {
  const costFor = (input) => pricing.calculateCost(
    "openai",
    "gpt-5.6-sol",
    simpleUsage(input),
    new Date("2026-07-10T00:00:00.000Z"),
    pricingOptions,
  );

  assert.equal(costFor(271_999).breakdown.input, 1.359995);
  assert.equal(costFor(272_000).breakdown.input, 1.36);
  assert.equal(costFor(272_001).breakdown.input, 2.72001);
});

test("unknown providers and models remain unpriced", () => {
  const usageValue = simpleUsage(1_000_000);

  assert.equal(pricing.calculateCost("other", "gpt-5-codex", usageValue, new Date(), pricingOptions).known, false);
  assert.equal(pricing.calculateCost("openai", "not-a-model", usageValue, new Date(), pricingOptions).known, false);
  assert.equal(reportModel.inferProvider("mystery-model"), "unknown");
});

test("reasoning output is clamped to visible output tokens", () => {
  const normalized = usage.normalizeUsage({ output: 10, reasoningOutput: 50, inputIncludesCacheRead: false });
  assert.equal(normalized.reasoningOutput, 10);

  const cost = pricing.calculateCost("openai", "gpt-5-codex", normalized, new Date(), pricingOptions);
  assert.equal(cost.reasoningAmount, cost.breakdown.output);
});

test("Anthropic historical pricing changes at the exact boundary", () => {
  const before = pricing.lookupAnthropicPrices("claude-sonnet-5", new Date("2026-08-31T23:59:59.999Z"));
  const after = pricing.lookupAnthropicPrices("claude-sonnet-5", new Date("2026-09-01T00:00:00.000Z"));

  assert.equal(before.input, 2);
  assert.equal(after.input, 3);
});

test("usage adapters accept aliases, malformed cache counts, and null values", () => {
  const aliased = usage.usageFromCodexTokenUsage({
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 },
    output_tokens: 3,
  }, 128_000);
  assert.deepEqual({
    input: aliased.input,
    cacheRead: aliased.cacheRead,
    cacheCreate30m: aliased.cacheCreate30m,
    output: aliased.output,
  }, { input: 75, cacheRead: 20, cacheCreate30m: 5, output: 3 });

  const malformed = usage.usageFromCodexTokenUsage({ input_tokens: 10, cached_input_tokens: 20, output_tokens: 1 });
  assert.equal(malformed.input, 0);
  assert.equal(malformed.cacheRead, 20);

  assert.equal(usage.usageFromCodexTokenUsage(null).input, 0);
  assert.equal(usage.usageFromClaudeUsage(null).output, 0);
});

test("normalizeUsage canonicalizes aliases and clamps negative derived input", () => {
  assert.deepEqual(usage.normalizeUsage({
    input: 10,
    cacheRead: 4,
    output: 3,
    reasoningOutput: 9,
  }), {
    input: 6,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 4,
    output: 3,
    reasoningOutput: 3,
    contextWindow: 0,
    inputIncludesCacheRead: false,
  });
  assert.equal(usage.normalizeUsage({ input: 10, cacheRead: 4, inputIncludesCacheRead: false }).input, 10);
});

test("cumulative usage resets expose sequenceReset and establish a new baseline", () => {
  const first = usage.usageFromCodexInfo({
    total_token_usage: { input_tokens: 100, output_tokens: 4 },
  });
  const reset = usage.usageFromCodexInfo({
    total_token_usage: { input_tokens: 10, output_tokens: 1 },
  }, first.totalUsage);
  const following = usage.usageFromCodexInfo({
    total_token_usage: { input_tokens: 15, output_tokens: 3 },
  }, reset.totalUsage);

  assert.equal(reset.usage.sequenceReset, true);
  assert.equal(reset.totalUsage.inputCounter, 10);
  assert.equal(reset.usage.inputCounter, 10);
  assert.equal(reset.usage.output, 1);
  assert.deepEqual({
    input: following.usage.input,
    inputCounter: following.usage.inputCounter,
    output: following.usage.output,
  }, {
    input: 5,
    inputCounter: 5,
    output: 2,
  });
});

test("date and ISO week keys honor their calendar boundaries", () => {
  const endOfDay = new Date(2026, 0, 4, 23, 59, 59, 999);
  const nextDay = new Date(2026, 0, 5, 0, 0, 0, 0);
  assert.equal(reportModel.dateKey(endOfDay), "2026-01-04");
  assert.equal(reportModel.dateKey(nextDay), "2026-01-05");
  assert.equal(reportModel.weekKey(new Date(2021, 0, 1)), "2020-W53");
  assert.equal(reportModel.weekKey(new Date(2021, 0, 4)), "2021-W01");
  assert.equal(reportModel.quarterHourKey(new Date("2026-07-10T12:14:59.999Z")), "2026-07-10T12:00Z");
  assert.equal(reportModel.quarterHourKey(new Date("2026-07-10T12:15:00.000Z")), "2026-07-10T12:15Z");
  assert.equal(reportModel.quarterHourKey(new Date(NaN)), null);
});

test("addUsage updates the shared report buckets through the aggregate module", () => {
  const report = reportModel.newReport();
  const added = aggregate.addUsage(report, {
    provider: "openai",
    model: "gpt-5-codex",
    project: "/tmp/core-test",
    effort: "HIGH",
    timestamp: new Date("2026-07-10T12:00:00.000Z"),
    usage: simpleUsage(100, 10),
  }, pricingOptions);

  assert.equal(added.usage.input, 100);
  assert.equal(report.total.requests, 1);
  assert.equal(report.daily["2026-07-10"].requests, 1);
  assert.equal(report.projects["/tmp/core-test"].requests, 1);
  assert.equal(report.quarterHourly["2026-07-10T12:00Z"].requests, 1);
  assert.equal(report.projectQuarterHourly["/tmp/core-test"]["2026-07-10T12:00Z"].requests, 1);
  assert.equal(report.efforts.high.requests, 1);
});

test("project model aggregation keeps provider identity for equal model ids", () => {
  const report = reportModel.newReport();
  const base = {
    model: "shared-model",
    project: "/tmp/provider-identity",
    effort: "high",
    timestamp: new Date("2026-07-10T12:00:00.000Z"),
    usage: simpleUsage(100, 10),
  };
  aggregate.addUsage(report, { ...base, provider: "openai" }, pricingOptions);
  aggregate.addUsage(report, { ...base, provider: "acme-ai" }, pricingOptions);

  assert.equal(report.projectProviderModels[base.project].openai[base.model].requests, 1);
  assert.equal(report.projectProviderModels[base.project]["acme-ai"][base.model].requests, 1);
  assert.equal(report.projectModels[base.project][base.model].requests, 2);
});

test("omp parser pins provider and derives cost from omp pricing (duplicate-timestamp gotcha)", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "omp-fixture");
  processLine(JSON.stringify({
    type: "session", version: 3, id: "019f8c6a-3c53-7000-ac25-ab8ebe94e943",
    timestamp: "2026-07-23T00:40:00.339Z", cwd: "/tmp/project-omp", title: "t",
  }), 1);
  // Duplicate-timestamp gotcha (RESEARCH.md §3 gotcha 1): the entry-level ISO
  // timestamp is shadowed by a trailing Unix-ms `timestamp`. After JSON.parse
  // the ms number wins — proves the §4.5 handling (new Date(<number>) = ms-epoch).
  processLine(JSON.stringify({
    type: "message", id: "4f9506d3", parentId: "7d542783",
    timestamp: "2026-07-23T00:42:17.380Z",
    message: { role: "assistant", content: [] },
    api: "anthropic-messages", provider: "zai", model: "glm-5.2",
    usage: {
      input: 994, output: 57, cacheRead: 39232, cacheWrite: 0, totalTokens: 40283,
      cost: { input: 0.0013916, output: 0.0002508, cacheRead: 0.01020032, cacheWrite: 0, total: 0.01184272 },
    },
    stopReason: "toolUse", timestamp: 1784767330214, responseId: "msg_x",
  }), 2);

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 994);
  assert.equal(report.total.cacheRead, 39232);
  assert.equal(report.total.output, 57);
  assert.equal(report.total.cacheCreate5m, 0);
  assert.ok(report.providerModels["omp/glm-5.2"]);
  assert.equal(report.projects["/tmp/project-omp"].requests, 1);
  // A3: provider is "omp" (NOT "zai"/"unknown") — inferProvider never reached.
  assert.ok(report.providers["omp"]);
  assert.equal(report.providers["zai"], undefined);
  assert.equal(report.providers["unknown"], undefined);

  const p = pricing.PRICING.omp.models["glm-5.2"];
  const expected = (994 * p.input + 39232 * p.cacheRead + 57 * p.output) / pricing.TOKENS_PER_PRICE_UNIT;
  assert.equal(Number(report.total.costUsd.toFixed(6)), Number(expected.toFixed(6)));
  // A5: omp's precomputed usage.cost (0.01184272) is NOT trusted.
  assert.notEqual(Number(report.total.costUsd.toFixed(6)), 0.01184272);
});

test("omp pricing resolves known models and flags unknown ones", () => {
  const p = pricing.PRICING.omp.models["glm-5.2"];
  const known = calculateCost("omp", "glm-5.2", simpleUsage(1_000_000, 500_000), new Date("2026-07-23T00:42:17.380Z"), pricingOptions);
  assert.equal(known.known, true);
  const expectedKnown = (1_000_000 * p.input + 500_000 * p.output) / pricing.TOKENS_PER_PRICE_UNIT;
  assert.equal(Number(known.amount.toFixed(6)), Number(expectedKnown.toFixed(6)));

  const unknown = calculateCost("omp", "glm-not-a-real-model", simpleUsage(100, 50), new Date("2026-07-23T00:42:17.380Z"), pricingOptions);
  assert.equal(unknown.known, false);
  assert.equal(unknown.amount, 0);
});
