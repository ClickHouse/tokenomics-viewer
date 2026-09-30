"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { calculateCost } = require("../lib/core/pricing");
const { defaultConfiguration, normalizeConfiguration, packagedPricingCatalogRevision, pricingOptionsFromConfiguration, pricingConfigurationSignature } = require("../lib/core/configuration");

const launch = new Date("2026-09-29T00:00:00.000Z");
const model = "gpt-6.1-sol";
const rates = {
  short: { input: 2, cacheCreate30m: 2.5, cacheRead: 0.1, output: 10 },
  long: { input: 4, cacheCreate30m: 5, cacheRead: 0.2, output: 15 },
};
const millionBuckets = {
  input: 1_000_000, cacheCreate30m: 1_000_000, cacheRead: 1_000_000,
  output: 1_000_000, reasoningOutput: 250_000, inputIncludesCacheRead: false,
};

function catalogOptions(extra = {}) {
  const configuration = defaultConfiguration();
  return { ...configuration.settings, pricingCatalog: configuration.prices, ...extra };
}

test("GPT-6.1 Sol official rates agree in direct and catalog pricing", () => {
  for (const variant of ["short", "long"]) {
    for (const options of [{ openaiContext: variant }, catalogOptions({ openaiContext: variant })]) {
      const cost = calculateCost("openai", model, millionBuckets, launch, options);
      assert.equal(cost.known, true);
      assert.deepEqual(cost.breakdown, { ...rates[variant], cacheCreate5m: 0, cacheCreate1h: 0 });
      assert.equal(cost.amount, variant === "short" ? 14.6 : 24.2);
      assert.equal(cost.reasoningAmount, variant === "short" ? 2.5 : 3.75);
    }
  }
});

test("GPT-6.1 Sol launch boundary, date snapshots, and model isolation", () => {
  for (const options of [{ openaiContext: "short" }, catalogOptions({ openaiContext: "short" })]) {
    const before = new Date(launch.getTime() - 1);
    assert.equal(calculateCost("openai", model, millionBuckets, before, options).known, false);
    for (const timestamp of [launch, new Date(launch.getTime() + 1)]) {
      assert.equal(calculateCost("openai", model, millionBuckets, timestamp, options).known, true);
      assert.equal(calculateCost("openai", `${model}-2026-09-29`, millionBuckets, timestamp, options).amount, 14.6);
    }
    for (const unknown of ["gpt-6.1", "gpt-6.1-sol-mini", "gpt-6.1-sol-preview", "gpt-6.1-sol-20260929"]) {
      assert.equal(calculateCost("openai", unknown, millionBuckets, launch, options).known, false, unknown);
    }
    assert.equal(calculateCost("openai", "gpt-6-sol", millionBuckets, launch, options).breakdown.cacheRead, 0.2);
  }
});

test("GPT-6.1 Sol 272K threshold counts input, cache writes, and cache reads", () => {
  for (const options of [{ openaiContext: "auto" }, catalogOptions()]) {
    for (const extra of [0, 1]) {
      const usage = { input: 1_000, cacheCreate30m: 1_000, cacheRead: 270_000 + extra, output: 100, inputIncludesCacheRead: false };
      const cost = calculateCost("openai", model, usage, launch, options);
      const expected = rates[extra === 0 ? "short" : "long"];
      assert.equal(cost.known, true);
      assert.equal(cost.breakdown.input, 1_000 * expected.input / 1_000_000);
      assert.equal(cost.breakdown.cacheCreate30m, 1_000 * expected.cacheCreate30m / 1_000_000);
      assert.equal(cost.breakdown.cacheRead, (270_000 + extra) * expected.cacheRead / 1_000_000);
      assert.equal(cost.breakdown.output, 100 * expected.output / 1_000_000);
    }
  }
});

test("GPT-6.1 Sol API and subscription Fast estimates respect the configured profile", () => {
  const standard = calculateCost("openai", model, millionBuckets, launch, catalogOptions({ openaiContext: "short" }));
  assert.equal(standard.known, true);
  for (const serviceTier of ["priority", "fast"]) {
    for (const [mode, multiplier] of [["api", 2], ["subscription", 2.5]]) {
      const configuration = defaultConfiguration();
      configuration.settings.openaiContext = "short";
      configuration.settings.usageProfile.mode = mode;
      const options = pricingOptionsFromConfiguration({ serviceTier }, configuration);
      const fast = calculateCost("openai", model, millionBuckets, launch, options);
      assert.equal(fast.amount, standard.amount * multiplier);
      assert.equal(fast.reasoningAmount, standard.reasoningAmount * multiplier);
      assert.equal(calculateCost("openai", `${model}-2026-09-29`, millionBuckets, launch, options).amount, fast.amount);
    }
    assert.equal(calculateCost("openai", model, millionBuckets, launch, { openaiContext: "short", serviceTier }).amount, standard.amount * 2.5);
    assert.equal(calculateCost("openai", model, millionBuckets, launch, catalogOptions({ openaiContext: "short", serviceTier, pricingBasis: "custom" })).amount, standard.amount);
  }
  for (const serviceTier of ["unknown", "default", "", "ultrafast"]) {
    assert.equal(calculateCost("openai", model, millionBuckets, launch, catalogOptions({ openaiContext: "short", serviceTier })).amount, standard.amount);
  }
});

test("GPT-6.1 Sol profile mode changes invalidate pricing but profile labels do not", () => {
  const api = defaultConfiguration();
  const subscription = structuredClone(api);
  subscription.settings.usageProfile.mode = "subscription";
  assert.notEqual(pricingConfigurationSignature(api), pricingConfigurationSignature(subscription));
  const renamed = structuredClone(api);
  renamed.settings.usageProfile = { id: "work", name: "Renamed API", mode: "api" };
  assert.equal(pricingConfigurationSignature(api), pricingConfigurationSignature(renamed));
  api.settings.pricingBasis = subscription.settings.pricingBasis = "custom";
  assert.equal(pricingConfigurationSignature(api), pricingConfigurationSignature(subscription));
});

test("packaged-7 catalog is recognized and upgraded without replacing edited tariffs", () => {
  const previous = defaultConfiguration().prices.filter((row) => row.model !== model);
  assert.equal(packagedPricingCatalogRevision(previous), "packaged-7");
  const edited = previous.map((row) => row.model === "gpt-6-sol" ? { ...row, input: 99 } : row);
  const upgraded = normalizeConfiguration({ revision: "old-7", settings: { ...defaultConfiguration().settings, pricingRevision: "packaged-7" }, prices: edited });
  assert.equal(upgraded.settings.pricingRevision, "packaged-8");
  for (const row of edited) assert.deepEqual(upgraded.prices.find((candidate) => candidate.id === row.id), row);
  for (const variant of ["short", "long"]) {
    const row = upgraded.prices.find((candidate) => candidate.model === model && candidate.variant === variant);
    assert.ok(row);
    assert.equal(row.effectiveFrom, launch.toISOString());
    assert.equal(row.sourceUrl, "https://developers.openai.com/api/docs/models/gpt-6.1-sol");
    for (const [field, value] of Object.entries(rates[variant])) assert.equal(row[field], value);
  }
  assert.equal(packagedPricingCatalogRevision(defaultConfiguration().prices), "packaged-8");
  const custom = normalizeConfiguration({ revision: "custom-7", settings: { ...defaultConfiguration().settings, pricingBasis: "custom", pricingRevision: "custom-7" }, prices: edited });
  assert.deepEqual(custom.prices, edited);
  assert.equal(custom.settings.pricingRevision, "custom-7");
});
