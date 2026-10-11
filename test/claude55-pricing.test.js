"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  defaultConfiguration,
  pricingOptionsFromConfiguration,
} = require("../lib/core/configuration");
const {
  calculateCost,
  lookupAnthropicPrices,
} = require("../lib/core/pricing");
const { buildClickHouseCostProjection } = require("../lib/storage/clickhouse-pricing");

const SONNET_LAUNCH = new Date("2026-09-28T00:00:00.000Z");
const HAIKU_LAUNCH = new Date("2026-10-07T00:00:00.000Z");
const HAIKU_BEFORE_LAUNCH = new Date("2026-10-06T23:59:59.999Z");

function costOptions(configuration = null) {
  return {
    openaiContext: "long",
    pricingCatalog: configuration?.prices,
    contextWindow: 2_000_000,
  };
}

test("Claude Sonnet 5.5 rates and launch boundary match the packaged catalog", () => {
  const configuration = defaultConfiguration();
  const sonnet = configuration.prices.find((row) => row.model === "claude-sonnet-5-5");
  assert.deepEqual(
    {
      effectiveFrom: sonnet.effectiveFrom,
      input: sonnet.input,
      cacheCreate5m: sonnet.cacheCreate5m,
      cacheCreate1h: sonnet.cacheCreate1h,
      cacheRead: sonnet.cacheRead,
      output: sonnet.output,
      sourceUrl: sonnet.sourceUrl,
    },
    {
      effectiveFrom: "2026-09-28T00:00:00.000Z",
      input: 2,
      cacheCreate5m: 2.5,
      cacheCreate1h: 4,
      cacheRead: 0.1,
      output: 10,
      sourceUrl: "https://platform.claude.com/docs/en/models/sonnet-5-5/overview",
    },
  );
  assert.equal(lookupAnthropicPrices("claude-sonnet-5-5-20260928", new Date("2026-09-27T23:59:59.999Z")), null);
  assert.equal(lookupAnthropicPrices("claude-sonnet-5-5-20260928", SONNET_LAUNCH).input, 2);
  const usage = {
    input: 1_000_000,
    cacheCreate5m: 1_000_000,
    cacheCreate1h: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
    inputIncludesCacheRead: false,
  };
  for (const pricingCatalog of [undefined, configuration.prices]) {
    const result = calculateCost("anthropic", "claude-sonnet-5-5-20260928", usage, SONNET_LAUNCH, {
      ...costOptions(),
      pricingCatalog,
    });
    assert.equal(result.known, true);
    assert.deepEqual(result.breakdown, {
      input: 2,
      cacheCreate5m: 2.5,
      cacheCreate30m: 0,
      cacheCreate1h: 4,
      cacheRead: 0.1,
      output: 10,
    });
  }
});

test("catalog and ClickHouse pricing do not fall through to Sonnet 5 before Sonnet 5.5 launches", () => {
  const configuration = defaultConfiguration();
  const usage = {
    input: 1,
    cacheRead: 100_000,
    output: 73,
    inputIncludesCacheRead: false,
  };
  const beforeLaunch = new Date("2026-09-27T23:59:59.999Z");
  const packagedOptions = pricingOptionsFromConfiguration({}, configuration);

  for (const model of ["claude-sonnet-5-5", "claude-sonnet-5-5-20260928"]) {
    const result = calculateCost("anthropic", model, usage, beforeLaunch, packagedOptions);
    assert.equal(result.known, false, `${model} must not inherit the Sonnet 5 prefix price before launch`);
    assert.equal(result.amount, 0);
  }

  const atLaunch = calculateCost(
    "anthropic",
    "claude-sonnet-5-5-20260928",
    usage,
    SONNET_LAUNCH,
    packagedOptions,
  );
  assert.equal(atLaunch.known, true);
  assert.ok(Math.abs(atLaunch.amount - 0.010732) < 1e-12);

  const customConfiguration = defaultConfiguration();
  customConfiguration.settings.pricingBasis = "custom";
  const custom = calculateCost(
    "anthropic",
    "claude-sonnet-5-5",
    usage,
    beforeLaunch,
    pricingOptionsFromConfiguration({}, customConfiguration),
  );
  assert.equal(custom.known, true, "custom pricing retains its existing prefix match behavior");
  assert.ok(Math.abs(custom.amount - 0.031098) < 1e-12);

  const sql = buildClickHouseCostProjection(configuration, {
    alias: "raw",
    timestamp: "raw.event_time",
    timestampIsDateTime: true,
  });
  const launchDate = Buffer.from("2026-09-28T00:00:00.000Z", "utf8").toString("base64");
  const model = Buffer.from("claude-sonnet-5-5", "utf8").toString("base64");
  assert.match(sql.matchExpression, new RegExp(`base64Decode\\('${model}'\\)`));
  const launchDateGuard = `raw.event_time < parseDateTime64BestEffort(base64Decode('${launchDate}'))`;
  const dateGuardIndex = sql.matchExpression.indexOf(launchDateGuard);
  const guardStart = sql.matchExpression.lastIndexOf("AND NOT (", dateGuardIndex);
  assert.ok(dateGuardIndex > guardStart, "SQL has a pre-launch exclusion guard");
  assert.ok(
    sql.matchExpression.slice(guardStart, dateGuardIndex).includes(`base64Decode('${model}')`),
    "the pre-launch exclusion matches the new Sonnet model id",
  );

  customConfiguration.settings.pricingBasis = "custom";
  const customSql = buildClickHouseCostProjection(customConfiguration, {
    alias: "raw",
    timestamp: "raw.event_time",
    timestampIsDateTime: true,
  });
  assert.doesNotMatch(
    customSql.matchExpression,
    new RegExp(`raw\\.event_time < parseDateTime64BestEffort\\(base64Decode\\('${launchDate}'\\)\\)`),
  );
});

test("Claude Haiku 5.5 uses strict total-input threshold including cache buckets", () => {
  const configuration = defaultConfiguration();
  const rows = configuration.prices.filter((row) => row.model === "claude-haiku-5-5");
  assert.deepEqual(rows.map((row) => ({
    variant: row.variant,
    effectiveFrom: row.effectiveFrom,
    input: row.input,
    cacheCreate5m: row.cacheCreate5m,
    cacheCreate1h: row.cacheCreate1h,
    cacheRead: row.cacheRead,
    output: row.output,
    sourceUrl: row.sourceUrl,
  })), [
    {
      variant: "long",
      effectiveFrom: "2026-10-07T00:00:00.000Z",
      input: 0.5,
      cacheCreate5m: 0.625,
      cacheCreate1h: 1,
      cacheRead: 0.05,
      output: 2.5,
      sourceUrl: "https://platform.claude.com/docs/en/models/haiku-5-5/overview",
    },
    {
      variant: "standard",
      effectiveFrom: "2026-10-07T00:00:00.000Z",
      input: 0.1,
      cacheCreate5m: 0.125,
      cacheCreate1h: 0.2,
      cacheRead: 0.01,
      output: 0.5,
      sourceUrl: "https://platform.claude.com/docs/en/models/haiku-5-5/overview",
    },
  ]);
  assert.equal(lookupAnthropicPrices("claude-haiku-5-5", HAIKU_BEFORE_LAUNCH), null);

  const cacheCreate5m = 20_000;
  const cacheCreate30m = 5_000;
  const cacheCreate1h = 10_000;
  const cacheRead = 10_001;
  for (const [totalPromptTokens, rate, outputRate] of [
    [99_999, 0.1, 0.5],
    [100_000, 0.1, 0.5],
    [100_001, 0.5, 2.5],
  ]) {
    const usage = {
      input: totalPromptTokens - cacheCreate5m - cacheCreate30m - cacheCreate1h - cacheRead,
      cacheCreate5m,
      cacheCreate30m,
      cacheCreate1h,
      cacheRead,
      output: 100_000,
      inputIncludesCacheRead: false,
    };
    const result = calculateCost(
      "anthropic",
      "claude-haiku-5-5-20261007",
      usage,
      HAIKU_LAUNCH,
      costOptions(configuration),
    );
    assert.equal(result.known, true);
    assert.equal(result.breakdown.input, (usage.input * rate) / 1_000_000);
    assert.equal(result.breakdown.cacheCreate5m, (cacheCreate5m * rate * 1.25) / 1_000_000);
    assert.equal(result.breakdown.cacheCreate30m, 0, "Anthropic has no 30-minute cache-write rate");
    assert.equal(result.breakdown.cacheCreate1h, (cacheCreate1h * rate * 2) / 1_000_000);
    assert.equal(result.breakdown.cacheRead, (cacheRead * rate * 0.1) / 1_000_000);
    assert.equal(result.breakdown.output, (usage.output * outputRate) / 1_000_000);
  }
});

test("Haiku tier ignores output size, OpenAI context settings, and contextWindow", () => {
  const usage = {
    input: 100_000,
    output: 1_000_000,
    inputIncludesCacheRead: false,
    contextWindow: 4_000_000,
  };

  for (const openaiContext of ["short", "auto", "long"]) {
    const configuration = defaultConfiguration();
    configuration.settings.openaiContext = openaiContext;
    const result = calculateCost(
      "anthropic",
      "claude-haiku-5-5",
      usage,
      HAIKU_LAUNCH,
      { ...pricingOptionsFromConfiguration({}, configuration), contextWindow: 4_000_000 },
    );
    assert.equal(result.breakdown.input, 0.01, `${openaiContext} OpenAI context setting does not alter the Haiku tier`);
    assert.equal(result.breakdown.output, 0.5, "large output does not select the higher prompt tier");
  }
});

test("Haiku's prompt tier preserves historical Anthropic custom pricing", () => {
  const configuration = defaultConfiguration();
  configuration.settings.pricingBasis = "custom";
  const standard = {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    matchMode: "prefix",
    variant: "standard",
    input: 3,
    output: 15,
    cacheCreate5m: 3.75,
    cacheCreate1h: 6,
    cacheRead: 0.3,
  };
  configuration.prices = [standard, { ...standard, variant: "long", input: 99, output: 199 }];
  const result = calculateCost("anthropic", "claude-sonnet-4-6", {
    input: 100_001,
    output: 1,
    inputIncludesCacheRead: false,
  }, HAIKU_LAUNCH, pricingOptionsFromConfiguration({}, configuration));
  assert.equal(result.known, true);
  assert.ok(Math.abs(result.amount - 0.300018) < 1e-12);
  const projection = buildClickHouseCostProjection(configuration);
  assert.doesNotMatch(projection.matchExpression, /toFloat64\(99\)/);
  assert.doesNotMatch(projection.matchExpression, /toFloat64\(199\)/);
});

test("ClickHouse projection emits the Haiku token threshold and both Anthropic tariffs", () => {
  const sql = buildClickHouseCostProjection(defaultConfiguration(), { alias: "raw" });
  const model = Buffer.from("claude-haiku-5-5", "utf8").toString("base64");
  assert.match(sql.matchExpression, new RegExp(`base64Decode\\('${model}'\\)`));
  assert.match(
    sql.matchExpression,
    /raw\.input \+ raw\.cache_create_5m \+ raw\.cache_create_30m \+ raw\.cache_create_1h \+ raw\.cache_read\) > 100000/,
  );
  assert.match(sql.matchExpression, /toNullable\(toFloat64\(0\.5\)\).*toNullable\(toFloat64\(0\.625\)\).*toNullable\(toFloat64\(1\)\).*toNullable\(toFloat64\(0\.05\)\).*toNullable\(toFloat64\(2\.5\)\)/);
  assert.match(sql.matchExpression, /toNullable\(toFloat64\(0\.1\)\).*toNullable\(toFloat64\(0\.125\)\).*toNullable\(toFloat64\(0\.2\)\).*toNullable\(toFloat64\(0\.01\)\).*toNullable\(toFloat64\(0\.5\)\)/);
});
