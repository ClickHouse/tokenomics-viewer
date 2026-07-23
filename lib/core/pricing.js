"use strict";

const {
  isValidDate,
  newCostBreakdown,
  normalizeModel,
  number,
} = require("./report-model");
const { normalizeUsage } = require("./usage");

const TOKENS_PER_PRICE_UNIT = 1_000_000;

const PRICING_SOURCES = {
  openai: "https://developers.openai.com/api/docs/pricing",
  openaiGpt56: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
  openaiGpt5: "https://developers.openai.com/api/docs/models/gpt-5",
  openaiGpt51: "https://developers.openai.com/api/docs/models/gpt-5.1",
  openaiCodex: "https://developers.openai.com/api/docs/models/gpt-5-codex",
  openaiCodexMini: "https://developers.openai.com/api/docs/models/codex-mini-latest",
  anthropic: "https://docs.anthropic.com/en/docs/about-claude/pricing",
  omp: "https://docs.z.ai/guides/overview/pricing",
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
  omp: {
    models: {
      // Official Z.AI (GLM/Zhipu) pricing — USD per 1M tokens.
      // Source: https://docs.z.ai/guides/overview/pricing (2026-07-22). cacheCreate=0: Cached Input Storage is limited-time free.
      "glm-5.2": { input: 1.40, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.26, output: 4.40 },
      "glm-5.1": { input: 1.40, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.26, output: 4.40 },
      "glm-5": { input: 1.00, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.20, output: 3.20 },
      "glm-5-turbo": { input: 1.20, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.24, output: 4.00 },
      "glm-4.7": { input: 0.60, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.11, output: 2.20 },
      "glm-4.7-flashx": { input: 0.07, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.01, output: 0.40 },
      "glm-4.6": { input: 0.60, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.11, output: 2.20 },
      "glm-4.5": { input: 0.60, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.11, output: 2.20 },
      "glm-4.5-x": { input: 2.20, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.45, output: 8.90 },
      "glm-4.5-air": { input: 0.20, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.03, output: 1.10 },
      "glm-4.5-airx": { input: 1.10, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0.22, output: 4.50 },
      "glm-4-32b-0414-128k": { input: 0.10, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0, output: 0.10 },
      "glm-4.7-flash": { input: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0, output: 0 }, // officially FREE
      "glm-4.5-flash": { input: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0, output: 0 }, // officially FREE
    },
  },
};

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

function lookupOmpPrices(model, timestamp) {
  const normalized = normalizeModel(model);
  const names = Object.keys(PRICING.omp.models).sort((a, b) => b.length - a.length);
  const key = names.find((name) => normalized === name || normalized.startsWith(`${name}-`));
  if (!key) return null;
  const entry = PRICING.omp.models[key];
  if (!Array.isArray(entry)) return entry;
  const ts = isValidDate(timestamp) ? timestamp.getTime() : Date.now();
  for (const timed of entry) {
    const from = timed.from ? Date.parse(timed.from) : Number.NEGATIVE_INFINITY;
    const until = timed.until ? Date.parse(timed.until) : Number.POSITIVE_INFINITY;
    if (ts >= from && ts <= until) return timed.prices;
  }
  return entry[entry.length - 1].prices;
}

function lookupOpenAIPrices(model, usage, options = {}) {
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

function pricingRowMatches(row, provider, normalizedModel, timestamp) {
  if (row.provider !== provider) return false;
  const base = normalizeModel(row.model);
  const modelMatches = row.matchMode === "prefix"
    ? normalizedModel === base || normalizedModel.startsWith(`${base}-`)
    : row.matchMode === "exact"
      ? normalizedModel === base
      : isOpenAIModelPriceMatch(normalizedModel, base);
  if (!modelMatches) return false;
  const time = isValidDate(timestamp) ? timestamp.getTime() : Date.now();
  if (row.effectiveFrom && time < Date.parse(row.effectiveFrom)) return false;
  if (row.effectiveUntil && time > Date.parse(row.effectiveUntil)) return false;
  return true;
}

function pricesFromCatalog(provider, model, usage, timestamp, options = {}) {
  if (!Array.isArray(options.pricingCatalog)) return null;
  const normalized = normalizeModel(model);
  const matches = options.pricingCatalog
    .filter((row) => pricingRowMatches(row, provider, normalized, timestamp))
    .sort((a, b) => b.model.length - a.model.length);
  if (matches.length === 0) return null;
  let variant = "standard";
  if (provider === "openai") {
    const hasLong = matches.some((row) => row.variant === "long");
    variant = options.openaiContext === "long" && hasLong
      ? "long"
      : options.openaiContext === "auto" && hasLong && openAIInputTokensForLongPricing(usage) > 272_000
        ? "long"
        : "short";
  }
  const row = matches.find((candidate) => candidate.variant === variant)
    || matches.find((candidate) => candidate.variant === "standard");
  if (!row) return null;
  return {
    input: row.input,
    cachedInput: row.cacheRead,
    cacheCreate5m: row.cacheCreate5m,
    cacheCreate30m: row.cacheCreate30m,
    cacheCreate1h: row.cacheCreate1h,
    cacheRead: row.cacheRead,
    output: row.output,
  };
}

function applyCostMultiplier(breakdown, multiplier) {
  const factor = Number.isFinite(Number(multiplier)) ? Number(multiplier) : 1;
  return Object.fromEntries(Object.entries(breakdown).map(([key, value]) => [key, number(value) * factor]));
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

function calculateCost(provider, model, usage, timestamp, options = {}) {
  const normalizedUsage = normalizeUsage(usage);
  const reasoningOutput = Math.min(number(normalizedUsage.reasoningOutput), number(normalizedUsage.output));
  const catalogPrices = pricesFromCatalog(provider, model, normalizedUsage, timestamp, options);
  if (catalogPrices) {
    const cachedInputPrice = catalogPrices.cachedInput ?? catalogPrices.cacheRead ?? catalogPrices.input;
    const breakdown = applyCostMultiplier({
      input: (normalizedUsage.input * catalogPrices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: (normalizedUsage.cacheCreate5m * number(catalogPrices.cacheCreate5m)) / TOKENS_PER_PRICE_UNIT,
      cacheCreate30m: (normalizedUsage.cacheCreate30m * number(catalogPrices.cacheCreate30m)) / TOKENS_PER_PRICE_UNIT,
      cacheCreate1h: (normalizedUsage.cacheCreate1h * number(catalogPrices.cacheCreate1h)) / TOKENS_PER_PRICE_UNIT,
      cacheRead: (normalizedUsage.cacheRead * cachedInputPrice) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * catalogPrices.output) / TOKENS_PER_PRICE_UNIT,
    }, options.regionalMultiplier);
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: ((reasoningOutput * catalogPrices.output) / TOKENS_PER_PRICE_UNIT) * number(options.regionalMultiplier || 1),
    };
  }
  if (provider === "anthropic") {
    const prices = Array.isArray(options.pricingCatalog) ? null : lookupAnthropicPrices(model, timestamp);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const breakdown = applyCostMultiplier({
      input: (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: (normalizedUsage.cacheCreate5m * prices.cacheCreate5m) / TOKENS_PER_PRICE_UNIT,
      cacheCreate30m: 0,
      cacheCreate1h: (normalizedUsage.cacheCreate1h * prices.cacheCreate1h) / TOKENS_PER_PRICE_UNIT,
      cacheRead: (normalizedUsage.cacheRead * prices.cacheRead) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    }, options.regionalMultiplier);
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: ((reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT) * number(options.regionalMultiplier || 1),
    };
  }

  if (provider === "openai") {
    const prices = Array.isArray(options.pricingCatalog) ? null : lookupOpenAIPrices(model, normalizedUsage, options);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const cachedInputPrice = prices.cachedInput ?? prices.input;
    const breakdown = applyCostMultiplier({
      input: (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: 0,
      cacheCreate30m: (normalizedUsage.cacheCreate30m * number(prices.cacheCreate30m)) / TOKENS_PER_PRICE_UNIT,
      cacheCreate1h: 0,
      cacheRead: (normalizedUsage.cacheRead * cachedInputPrice) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    }, options.regionalMultiplier);
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: ((reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT) * number(options.regionalMultiplier || 1),
    };
  }

  if (provider === "omp") {
    const prices = Array.isArray(options.pricingCatalog) ? null : lookupOmpPrices(model, timestamp);
    if (!prices) return { known: false, amount: 0, breakdown: newCostBreakdown(), reasoningAmount: 0 };
    const breakdown = applyCostMultiplier({
      input: (normalizedUsage.input * prices.input) / TOKENS_PER_PRICE_UNIT,
      cacheCreate5m: (normalizedUsage.cacheCreate5m * prices.cacheCreate5m) / TOKENS_PER_PRICE_UNIT,
      cacheCreate30m: 0,
      cacheCreate1h: (normalizedUsage.cacheCreate1h * prices.cacheCreate1h) / TOKENS_PER_PRICE_UNIT,
      cacheRead: (normalizedUsage.cacheRead * prices.cacheRead) / TOKENS_PER_PRICE_UNIT,
      output: (normalizedUsage.output * prices.output) / TOKENS_PER_PRICE_UNIT,
    }, options.regionalMultiplier);
    return {
      known: true,
      amount: sumCostBreakdown(breakdown),
      breakdown,
      reasoningAmount: ((reasoningOutput * prices.output) / TOKENS_PER_PRICE_UNIT) * number(options.regionalMultiplier || 1),
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

module.exports = {
  PRICING,
  PRICING_SOURCES,
  TOKENS_PER_PRICE_UNIT,
  calculateCost,
  isOpenAIModelPriceMatch,
  lookupAnthropicPrices,
  lookupOmpPrices,
  lookupOpenAIPrices,
  openAIInputTokensForLongPricing,
  pricesFromCatalog,
  sumCostBreakdown,
};
