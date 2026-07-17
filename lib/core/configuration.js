"use strict";

const { PRICING, PRICING_SOURCES } = require("./pricing");

const PACKAGED_CONFIGURATION_REVISION = "packaged-1";
const ALLOWED_SETTINGS = new Set(["openaiContext", "pricingBasis", "regionalMultiplier", "monthlyCostLimitUsd"]);
const ALLOWED_MATCH_MODES = new Set(["snapshot", "prefix", "exact"]);
const ALLOWED_VARIANTS = new Set(["standard", "short", "long"]);
const PRICE_FIELDS = ["input", "cacheCreate5m", "cacheCreate30m", "cacheCreate1h", "cacheRead", "output"];

function pricingRowId(row) {
  return [
    row.provider,
    row.model,
    row.variant,
    row.effectiveFrom || "",
    row.effectiveUntil || "",
  ].join(":");
}

function rowFromPrices(provider, model, variant, prices, extra = {}) {
  const row = {
    id: "",
    provider,
    model,
    matchMode: provider === "anthropic" ? "prefix" : "snapshot",
    variant,
    effectiveFrom: extra.effectiveFrom || null,
    effectiveUntil: extra.effectiveUntil || null,
    input: prices.input,
    cacheCreate5m: prices.cacheCreate5m ?? null,
    cacheCreate30m: prices.cacheCreate30m ?? null,
    cacheCreate1h: prices.cacheCreate1h ?? null,
    cacheRead: provider === "openai" ? (prices.cachedInput ?? null) : (prices.cacheRead ?? null),
    output: prices.output,
    sourceUrl: provider === "openai" ? PRICING_SOURCES.openai : PRICING_SOURCES.anthropic,
  };
  row.id = pricingRowId(row);
  return row;
}

function packagedPricingRows() {
  const rows = [];
  for (const [model, variants] of Object.entries(PRICING.openai.models)) {
    for (const [variant, prices] of Object.entries(variants)) {
      rows.push(rowFromPrices("openai", model, variant, prices));
    }
  }
  for (const [model, entry] of Object.entries(PRICING.anthropic.models)) {
    if (Array.isArray(entry)) {
      for (const timed of entry) {
        rows.push(rowFromPrices("anthropic", model, "standard", timed.prices, {
          effectiveFrom: timed.from,
          effectiveUntil: timed.until,
        }));
      }
    } else {
      rows.push(rowFromPrices("anthropic", model, "standard", entry));
    }
  }
  return rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.variant.localeCompare(b.variant) || a.id.localeCompare(b.id));
}

function defaultConfiguration() {
  return normalizeConfiguration({
    revision: PACKAGED_CONFIGURATION_REVISION,
    settings: {
      openaiContext: "auto",
      pricingBasis: "standard",
      regionalMultiplier: 1,
      monthlyCostLimitUsd: null,
    },
    prices: packagedPricingRows(),
  });
}

function normalizedDate(value, field, rowId) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`pricing row ${rowId} ${field} must be an ISO date`);
  return new Date(text).toISOString();
}

function normalizedPrice(value, field, rowId, required = false) {
  if (value === null || value === undefined || value === "") {
    if (required) throw new Error(`pricing row ${rowId} ${field} must be a non-negative number`);
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`pricing row ${rowId} ${field} must be a non-negative number`);
  }
  return parsed;
}

function normalizePricingRow(source, index) {
  const label = source?.id || `#${index + 1}`;
  const provider = String(source?.provider || "").trim().toLowerCase();
  const model = String(source?.model || "").trim().toLowerCase();
  const matchMode = String(source?.matchMode || (provider === "anthropic" ? "prefix" : "snapshot")).trim().toLowerCase();
  const variant = String(source?.variant || (provider === "anthropic" ? "standard" : "short")).trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(provider)) throw new Error(`pricing row ${label} provider must be a lowercase provider slug`);
  if (!model || model.length > 160) throw new Error(`pricing row ${label} model must be a non-empty model id`);
  if (!ALLOWED_MATCH_MODES.has(matchMode)) throw new Error(`pricing row ${label} has invalid matchMode`);
  if (!ALLOWED_VARIANTS.has(variant)) throw new Error(`pricing row ${label} has invalid variant`);
  const effectiveFrom = normalizedDate(source.effectiveFrom, "effectiveFrom", label);
  const effectiveUntil = normalizedDate(source.effectiveUntil, "effectiveUntil", label);
  if (effectiveFrom && effectiveUntil && Date.parse(effectiveFrom) > Date.parse(effectiveUntil)) {
    throw new Error(`pricing row ${label} effectiveFrom must not be after effectiveUntil`);
  }
  const row = {
    id: "",
    provider,
    model,
    matchMode,
    variant,
    effectiveFrom,
    effectiveUntil,
    input: normalizedPrice(source.input, "input", label, true),
    cacheCreate5m: normalizedPrice(source.cacheCreate5m, "cacheCreate5m", label),
    cacheCreate30m: normalizedPrice(source.cacheCreate30m, "cacheCreate30m", label),
    cacheCreate1h: normalizedPrice(source.cacheCreate1h, "cacheCreate1h", label),
    cacheRead: normalizedPrice(source.cacheRead, "cacheRead", label),
    output: normalizedPrice(source.output, "output", label, true),
    sourceUrl: String(source.sourceUrl || "").trim().slice(0, 2_000),
  };
  row.id = pricingRowId(row);
  return row;
}

function normalizeConfiguration(source = {}) {
  const revision = String(source.revision || "").trim();
  if (!revision || revision.length > 160) throw new Error("configuration revision must be a non-empty string");
  const rawSettings = source.settings && typeof source.settings === "object" && !Array.isArray(source.settings)
    ? source.settings
    : {};
  for (const key of Object.keys(rawSettings)) {
    if (!ALLOWED_SETTINGS.has(key)) throw new Error(`unknown setting: ${key}`);
  }
  const openaiContext = String(rawSettings.openaiContext || "auto").trim().toLowerCase();
  if (!["auto", "short", "long"].includes(openaiContext)) throw new Error("openaiContext must be auto, short, or long");
  const pricingBasis = String(rawSettings.pricingBasis || "standard").trim().toLowerCase();
  if (!["standard", "custom"].includes(pricingBasis)) {
    throw new Error("pricingBasis must be standard or custom");
  }
  const regionalMultiplier = Number(rawSettings.regionalMultiplier ?? 1);
  if (!Number.isFinite(regionalMultiplier) || regionalMultiplier < 0.5 || regionalMultiplier > 2) {
    throw new Error("regionalMultiplier must be between 0.5 and 2");
  }
  const monthlyCostLimitUsd = rawSettings.monthlyCostLimitUsd === null ||
    rawSettings.monthlyCostLimitUsd === undefined || rawSettings.monthlyCostLimitUsd === ""
    ? null
    : Number(rawSettings.monthlyCostLimitUsd);
  if (monthlyCostLimitUsd !== null && (!Number.isFinite(monthlyCostLimitUsd) || monthlyCostLimitUsd <= 0)) {
    throw new Error("monthlyCostLimitUsd must be a positive number or null");
  }
  if (!Array.isArray(source.prices) || source.prices.length === 0 || source.prices.length > 1_000) {
    throw new Error("configuration prices must contain between 1 and 1000 rows");
  }
  const prices = source.prices.map(normalizePricingRow)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.variant.localeCompare(b.variant) || a.id.localeCompare(b.id));
  const ids = new Set();
  for (const row of prices) {
    if (ids.has(row.id)) throw new Error(`duplicate pricing row: ${row.id}`);
    ids.add(row.id);
  }
  const intervals = new Map();
  for (const row of prices) {
    const key = `${row.provider}\u0000${row.model}\u0000${row.variant}`;
    const siblings = intervals.get(key) || [];
    const from = row.effectiveFrom ? Date.parse(row.effectiveFrom) : Number.NEGATIVE_INFINITY;
    const until = row.effectiveUntil ? Date.parse(row.effectiveUntil) : Number.POSITIVE_INFINITY;
    if (siblings.some((interval) => from <= interval.until && interval.from <= until)) {
      throw new Error(`overlapping pricing rows: ${row.provider}/${row.model}/${row.variant}`);
    }
    siblings.push({ from, until });
    intervals.set(key, siblings);
  }
  return {
    revision,
    settings: { openaiContext, pricingBasis, regionalMultiplier, monthlyCostLimitUsd },
    prices,
  };
}

function pricingOptionsFromConfiguration(options, configuration) {
  const normalized = normalizeConfiguration(configuration);
  return {
    ...options,
    openaiContext: normalized.settings.openaiContext,
    pricingBasis: normalized.settings.pricingBasis,
    regionalMultiplier: normalized.settings.regionalMultiplier,
    pricingCatalog: normalized.prices,
    pricingRevision: normalized.revision,
  };
}

module.exports = {
  PACKAGED_CONFIGURATION_REVISION,
  PRICE_FIELDS,
  defaultConfiguration,
  normalizeConfiguration,
  packagedPricingRows,
  pricingOptionsFromConfiguration,
  pricingRowId,
};
