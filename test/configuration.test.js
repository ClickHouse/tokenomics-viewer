"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const {
  defaultConfiguration,
  isLegacyPackagedPricingCatalog,
  normalizeConfiguration,
} = require("../lib/core/configuration");
const { calculateCost } = require("../lib/core/pricing");
const { loadConfiguration, saveConfiguration } = require("../app");
const { defaultOptions } = require("./support/fixtures");

test("default configuration exposes a validated editable pricing catalog", () => {
  const configuration = defaultConfiguration();

  assert.equal(configuration.settings.openaiContext, "auto");
  assert.equal(configuration.settings.pricingBasis, "standard");
  assert.equal(configuration.settings.regionalMultiplier, 1);
  assert.equal(configuration.settings.monthlyCostLimitUsd, null);
  assert.equal(configuration.settings.pricingRevision, "packaged-4");
  assert.deepEqual(configuration.settings.usageProfile, {
    id: "default",
    name: "Work API",
    mode: "api",
  });
  assert.ok(configuration.prices.some((row) => row.provider === "openai" && row.model === "gpt-5.6-luna" && row.variant === "short"));
  assert.ok(configuration.prices.some((row) => row.provider === "openai" && row.model === "codex-auto-review" && row.variant === "short"));
  const opus5 = configuration.prices.find((row) => row.provider === "anthropic" && row.model === "claude-opus-5");
  const opus48 = configuration.prices.find((row) => row.provider === "anthropic" && row.model === "claude-opus-4-8");
  assert.ok(opus5);
  assert.ok(opus48);
  for (const field of ["input", "cacheCreate5m", "cacheCreate1h", "cacheRead", "output"]) {
    assert.equal(opus5[field], opus48[field], `${field} pricing must match Opus 4.8`);
  }
  assert.deepEqual(normalizeConfiguration(configuration), configuration);
});

test("default GPT-5.6 Luna and Terra rows match the current official standard rates", () => {
  const configuration = defaultConfiguration();
  const expected = {
    "gpt-5.6-terra": {
      short: { input: 2, cacheRead: 0.2, cacheCreate30m: 2.5, output: 12 },
      long: { input: 4, cacheRead: 0.4, cacheCreate30m: 5, output: 18 },
    },
    "gpt-5.6-luna": {
      short: { input: 0.2, cacheRead: 0.02, cacheCreate30m: 0.25, output: 1.2 },
      long: { input: 0.4, cacheRead: 0.04, cacheCreate30m: 0.5, output: 1.8 },
    },
  };

  for (const [model, variants] of Object.entries(expected)) {
    for (const [variant, rates] of Object.entries(variants)) {
      const row = configuration.prices.find((candidate) => (
        candidate.provider === "openai" && candidate.model === model && candidate.variant === variant &&
        candidate.effectiveFrom === "2026-07-30T00:00:00.000Z"
      ));
      assert.ok(row, `${model}/${variant} packaged row is present`);
      for (const [field, value] of Object.entries(rates)) {
        assert.equal(row[field], value, `${model}/${variant} ${field} rate`);
      }
      assert.equal(row.sourceUrl, "https://developers.openai.com/api/docs/pricing");
    }
  }
});

test("default GPT-5.6 Luna and Terra rows preserve the historical pricing boundary", () => {
  const configuration = defaultConfiguration();
  const oldUntil = "2026-07-29T23:59:59.999Z";
  const currentFrom = "2026-07-30T00:00:00.000Z";
  const expected = {
    "gpt-5.6-terra": {
      old: { input: 2.5, cacheRead: 0.25, cacheCreate30m: 3.125, output: 15 },
      current: { input: 2, cacheRead: 0.2, cacheCreate30m: 2.5, output: 12 },
    },
    "gpt-5.6-luna": {
      old: { input: 1, cacheRead: 0.1, cacheCreate30m: 1.25, output: 6 },
      current: { input: 0.2, cacheRead: 0.02, cacheCreate30m: 0.25, output: 1.2 },
    },
  };

  for (const [model, rates] of Object.entries(expected)) {
    for (const variant of ["short", "long"]) {
      const oldRates = variant === "long"
        ? Object.fromEntries(Object.entries(rates.old).map(([key, value]) => [key, Number((value * (key === "output" ? 1.5 : 2)).toFixed(6))]))
        : rates.old;
      const currentRates = variant === "long"
        ? Object.fromEntries(Object.entries(rates.current).map(([key, value]) => [key, Number((value * (key === "output" ? 1.5 : 2)).toFixed(6))]))
        : rates.current;
      const oldRow = configuration.prices.find((row) => (
        row.provider === "openai" && row.model === model && row.variant === variant && row.effectiveUntil === oldUntil
      ));
      const currentRow = configuration.prices.find((row) => (
        row.provider === "openai" && row.model === model && row.variant === variant && row.effectiveFrom === currentFrom
      ));

      assert.ok(oldRow, `${model}/${variant} historical packaged row is present`);
      assert.ok(currentRow, `${model}/${variant} current packaged row is present`);
      for (const [field, value] of Object.entries(oldRates)) {
        assert.equal(oldRow[field], value, `${model}/${variant} historical ${field} rate`);
      }
      for (const [field, value] of Object.entries(currentRates)) {
        assert.equal(currentRow[field], value, `${model}/${variant} current ${field} rate`);
      }
    }
  }
});

test("legacy packaged catalog recognition rejects even tiny tariff edits", () => {
  const temporalModels = new Set(["gpt-5.6-luna", "gpt-5.6-terra"]);
  const legacy = defaultConfiguration().prices.flatMap((row) => {
    if (!temporalModels.has(row.model)) return [row];
    if (!row.effectiveUntil) return [];
    return [{ ...row, effectiveFrom: null, effectiveUntil: null }];
  });

  assert.equal(isLegacyPackagedPricingCatalog(legacy), true);
  legacy.find((row) => row.model === "gpt-5.6-luna" && row.variant === "short").input = 1.000000000000001;
  assert.equal(isLegacyPackagedPricingCatalog(legacy), false);
});

test("packaged-2 pricing is upgraded with Opus 5 without replacing persisted rows", () => {
  const configuration = defaultConfiguration();
  configuration.revision = "packaged-2";
  configuration.settings.pricingRevision = "packaged-2";
  configuration.prices = configuration.prices.filter((row) => row.model !== "claude-opus-5");
  const luna = configuration.prices.find((row) => (
    row.provider === "openai" && row.model === "gpt-5.6-luna" && row.variant === "short"
  ));
  luna.input = 2;

  const normalized = normalizeConfiguration(configuration);

  assert.equal(normalized.settings.pricingRevision, "packaged-4");
  assert.equal(normalized.prices.find((row) => row.id === luna.id).input, 2);
  assert.ok(normalized.prices.some((row) => row.provider === "anthropic" && row.model === "claude-opus-5"));
});

test("packaged-1 pricing is upgraded with codex-auto-review without replacing persisted rows", () => {
  const configuration = defaultConfiguration();
  configuration.revision = "packaged-1";
  configuration.settings.pricingRevision = "packaged-1";
  configuration.prices = configuration.prices.filter((row) => row.model !== "codex-auto-review");
  const luna = configuration.prices.find((row) => (
    row.provider === "openai" && row.model === "gpt-5.6-luna" && row.variant === "short"
  ));
  luna.input = 2;

  const normalized = normalizeConfiguration(configuration);

  assert.equal(normalized.settings.pricingRevision, "packaged-4");
  assert.equal(normalized.prices.find((row) => row.id === luna.id).input, 2);
  assert.ok(normalized.prices.some((row) => row.provider === "openai" && row.model === "codex-auto-review"));
});

test("standard edited catalogs get a stable pricing-engine revision and auto-review row", () => {
  const configuration = defaultConfiguration();
  configuration.settings.pricingRevision = "edited-catalog-1";
  configuration.prices = configuration.prices.filter((row) => row.model !== "codex-auto-review");

  const normalized = normalizeConfiguration(configuration);

  assert.match(normalized.settings.pricingRevision, /^packaged-4:[0-9a-f]{32}$/);
  assert.equal(normalizeConfiguration(normalized).settings.pricingRevision, normalized.settings.pricingRevision);
  assert.ok(normalized.prices.some((row) => row.provider === "openai" && row.model === "codex-auto-review"));

  configuration.settings.pricingBasis = "custom";
  const custom = normalizeConfiguration(configuration);
  assert.equal(custom.settings.pricingRevision, "edited-catalog-1");
  assert.equal(custom.prices.some((row) => row.model === "codex-auto-review"), false);
});

test("managed packaged overlay revisions remain distinct from edited standard catalogs", () => {
  const configuration = defaultConfiguration();
  const currentManagedRevision = `packaged-4:managed:${"a".repeat(32)}`;
  configuration.settings.pricingRevision = currentManagedRevision;

  assert.equal(normalizeConfiguration(configuration).settings.pricingRevision, currentManagedRevision);

  configuration.settings.pricingRevision = `packaged-3:managed:${"b".repeat(32)}`;
  assert.match(
    normalizeConfiguration(configuration).settings.pricingRevision,
    /^packaged-4:managed:[0-9a-f]{32}$/,
  );
});

test("database pricing rows override packaged prices and apply the regional multiplier", () => {
  const configuration = defaultConfiguration();
  const luna = configuration.prices.find((row) => row.provider === "openai" && row.model === "gpt-5.6-luna" && row.variant === "short");
  luna.input = 2;
  luna.cacheRead = 0.2;
  luna.output = 12;
  configuration.settings.regionalMultiplier = 1.1;

  const cost = calculateCost("openai", "gpt-5.6-luna", {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
    inputIncludesCacheRead: false,
  }, new Date("2026-07-14T00:00:00.000Z"), {
    openaiContext: "short",
    pricingCatalog: configuration.prices,
    regionalMultiplier: configuration.settings.regionalMultiplier,
  });

  assert.equal(cost.known, true);
  assert.equal(Number(cost.amount.toFixed(6)), 15.62);
  assert.deepEqual(Object.fromEntries(Object.entries(cost.breakdown).map(([key, value]) => [key, Number(value.toFixed(6))])), {
    input: 2.2,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.22,
    output: 13.2,
  });
});

test("configuration validation rejects stale or ambiguous pricing input", () => {
  const configuration = defaultConfiguration();
  configuration.prices[0].input = -1;
  assert.throws(() => normalizeConfiguration(configuration), /input must be a non-negative number/);

  const unknownSetting = defaultConfiguration();
  unknownSetting.settings.extra = true;
  assert.throws(() => normalizeConfiguration(unknownSetting), /unknown setting/);

  const duplicate = defaultConfiguration();
  duplicate.prices.push({ ...duplicate.prices[0] });
  assert.throws(() => normalizeConfiguration(duplicate), /duplicate pricing row/);

  const overlapping = defaultConfiguration();
  const first = overlapping.prices.find((row) => row.provider === "anthropic" && row.model === "claude-sonnet-5");
  overlapping.prices.push({
    ...first,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: "2026-08-15T00:00:00.000Z",
  });
  assert.throws(() => normalizeConfiguration(overlapping), /overlapping pricing rows/);

  const unsupportedBasis = defaultConfiguration();
  unsupportedBasis.settings.pricingBasis = "batch";
  assert.throws(() => normalizeConfiguration(unsupportedBasis), /pricingBasis must be standard or custom/);

  const invalidMonthlyLimit = defaultConfiguration();
  invalidMonthlyLimit.settings.monthlyCostLimitUsd = 0;
  assert.throws(() => normalizeConfiguration(invalidMonthlyLimit), /monthlyCostLimitUsd must be a positive number or null/);
});

test("configuration preserves an optional monthly cost limit", () => {
  const configuration = defaultConfiguration();
  configuration.settings.monthlyCostLimitUsd = 10_000;

  assert.equal(normalizeConfiguration(configuration).settings.monthlyCostLimitUsd, 10_000);
});

test("legacy configuration receives the default API usage profile", () => {
  const configuration = defaultConfiguration();
  delete configuration.settings.usageProfile;
  delete configuration.settings.pricingRevision;

  const normalized = normalizeConfiguration(configuration);
  assert.deepEqual(normalized.settings.usageProfile, {
    id: "default",
    name: "Work API",
    mode: "api",
  });
  assert.equal(normalized.settings.pricingRevision, configuration.revision);
});

test("configuration validates usage profile billing semantics", () => {
  const unsupported = defaultConfiguration();
  unsupported.settings.usageProfile.mode = "hybrid";
  assert.throws(() => normalizeConfiguration(unsupported), /usageProfile mode must be api or subscription/);

  const unnamed = defaultConfiguration();
  unnamed.settings.usageProfile.name = " ";
  assert.throws(() => normalizeConfiguration(unnamed), /usageProfile name must be non-empty/);

  const subscriptionBudget = defaultConfiguration();
  subscriptionBudget.settings.usageProfile = {
    id: "home",
    name: "Home Subscription",
    mode: "subscription",
  };
  subscriptionBudget.settings.monthlyCostLimitUsd = 100;
  assert.throws(() => normalizeConfiguration(subscriptionBudget), /monthlyCostLimitUsd is only supported for API profiles/);
});

test("custom providers and models use generic database pricing rows", () => {
  const configuration = defaultConfiguration();
  configuration.prices.push({
    id: "custom",
    provider: "acme-ai",
    model: "acme-reasoner",
    matchMode: "exact",
    variant: "standard",
    effectiveFrom: null,
    effectiveUntil: null,
    input: 3,
    cacheCreate5m: 4,
    cacheCreate30m: null,
    cacheCreate1h: null,
    cacheRead: 0.3,
    output: 9,
    sourceUrl: "https://example.invalid/pricing",
  });
  const normalized = normalizeConfiguration(configuration);
  const cost = calculateCost("acme-ai", "acme-reasoner", {
    input: 1_000_000,
    cacheCreate5m: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
    inputIncludesCacheRead: false,
  }, new Date(), { pricingCatalog: normalized.prices });

  assert.equal(cost.known, true);
  assert.equal(cost.amount, 16.3);
});

test("a standard OpenAI catalog row prices a context-independent custom model", () => {
  const configuration = defaultConfiguration();
  configuration.prices.push({
    provider: "openai",
    model: "gpt-custom-flat",
    matchMode: "exact",
    variant: "standard",
    input: 2,
    cacheRead: 0.2,
    output: 8,
    sourceUrl: "https://example.invalid/pricing",
  });
  const normalized = normalizeConfiguration(configuration);

  const cost = calculateCost("openai", "gpt-custom-flat", {
    input: 1_000_000,
    cacheRead: 1_000_000,
    output: 1_000_000,
    inputIncludesCacheRead: false,
  }, new Date(), { pricingCatalog: normalized.prices, openaiContext: "auto" });

  assert.equal(cost.known, true);
  assert.equal(cost.amount, 10.2);
});

test("SQLite configuration revisions round-trip and reject stale writers", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-configuration-test-"));
  const options = defaultOptions({ db: Path.join(tmp, "tokenomics.sqlite"), dbEngine: "sqlite" });
  const initial = await loadConfiguration(options);
  const edited = structuredClone(initial);
  edited.settings.regionalMultiplier = 1.1;
  edited.settings.monthlyCostLimitUsd = 10_000;

  const saved = await saveConfiguration(options, edited);
  assert.notEqual(saved.revision, initial.revision);
  const reloaded = await loadConfiguration(options);
  assert.equal(reloaded.settings.regionalMultiplier, 1.1);
  assert.equal(reloaded.settings.monthlyCostLimitUsd, 10_000);
  await assert.rejects(saveConfiguration(options, edited), /configuration revision conflict/);
});

test("SQLite profile-only configuration changes preserve the backend pricing revision", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-profile-configuration-test-"));
  const options = defaultOptions({ db: Path.join(tmp, "tokenomics.sqlite"), dbEngine: "sqlite" });
  const initial = await loadConfiguration(options);
  const edited = structuredClone(initial);
  delete edited.settings.pricingRevision;
  edited.settings.usageProfile = { id: "home", name: "Home Subscription", mode: "subscription" };

  const saved = await saveConfiguration(options, edited);
  assert.notEqual(saved.revision, initial.revision);
  assert.equal(saved.settings.pricingRevision, initial.settings.pricingRevision);
});
