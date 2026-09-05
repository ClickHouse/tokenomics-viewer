"use strict";

const { createHash } = require("node:crypto");
const { PRICING, PRICING_SOURCES } = require("./pricing");

const PACKAGED_CONFIGURATION_REVISION = "packaged-5";
const ALLOWED_SETTINGS = new Set(["openaiContext", "pricingBasis", "pricingRevision", "regionalMultiplier", "monthlyCostLimitUsd", "usageProfile"]);
const ALLOWED_MATCH_MODES = new Set(["snapshot", "prefix", "exact"]);
const ALLOWED_VARIANTS = new Set(["standard", "short", "long"]);
const PRICE_FIELDS = ["input", "cacheCreate5m", "cacheCreate30m", "cacheCreate1h", "cacheRead", "output"];
const DERIVED_PACKAGED_REVISION_RE = /^packaged-(\d+):([0-9a-f]{32})$/;
const MANAGED_PACKAGED_REVISION_RE = /^packaged-(\d+):managed:([0-9a-f]{32})$/;
const LEGACY_PACKAGED_CONFIGURATION_REVISION = "packaged-3";
// Exact normalized 63-row packaged-3 catalog. This admits the one-time repair
// without guessing that arbitrary derived standard catalogs are managed.
const LEGACY_PACKAGED_3_CATALOG_SIGNATURE = "35dc489b59c5c2075f4e995081f3f110505a7da73312c6febd1b3b9926c069e5";
// The same catalog after the Float64 JSON round trip observed in ClickHouse.
const LEGACY_PACKAGED_3_CLICKHOUSE_CATALOG_SIGNATURE = "74902efdcc89bc1aece721d1e99eee36a2791aa023f1f33cadf15ac5753f8e8d";
const PACKAGED_4_CATALOG_SIGNATURE = "90161eead388329f274372c80e38da02a5c9f35ba53bf1e8bfc37e4dd79a078a";
const PACKAGED_4_CLICKHOUSE_CATALOG_SIGNATURE = "363f3a993b26f3680bf0842577c14e93efbf76726ea9130eb75eba5ecdf483ef";
const PACKAGED_5_CATALOG_SIGNATURE = "5ec7d98e245ec35398a75660e43bc634a051fbd91f356c141f6fd59a371695ba";
const PACKAGED_5_CLICKHOUSE_CATALOG_SIGNATURE = "4015c4a91a133a023f8c057b9d4f512632d3a00d30d4c63de522a92366e0e4cd";

function pricingRowId(row) {
  return [
    row.provider,
    row.model,
    row.variant,
    row.effectiveFrom || "",
    row.effectiveUntil || "",
  ].join(":");
}

function pricingRowKey(row) {
  return `${row.provider}\u0000${row.model}\u0000${row.variant}`;
}

function migrateLegacyTimedPackagedRows(rows, packagedRows) {
  const historicalRows = new Map();
  for (const row of packagedRows) {
    if (!row.effectiveUntil || row.effectiveFrom) continue;
    const key = pricingRowKey(row);
    const previous = historicalRows.get(key);
    if (!previous || Date.parse(row.effectiveUntil) < Date.parse(previous.effectiveUntil)) {
      historicalRows.set(key, row);
    }
  }
  for (const row of rows) {
    if (row.effectiveFrom || row.effectiveUntil) continue;
    const historical = historicalRows.get(pricingRowKey(row));
    if (!historical) continue;
    Object.assign(row, historical);
  }
}

function rowFromPrices(provider, model, variant, prices, extra = {}) {
  const row = {
    id: "",
    provider,
    model,
    matchMode: provider === "openai" ? "snapshot" : "prefix",
    variant,
    effectiveFrom: extra.effectiveFrom || null,
    effectiveUntil: extra.effectiveUntil || null,
    input: prices.input,
    cacheCreate5m: prices.cacheCreate5m ?? null,
    cacheCreate30m: prices.cacheCreate30m ?? null,
    cacheCreate1h: prices.cacheCreate1h ?? null,
    cacheRead: provider === "openai" ? (prices.cachedInput ?? null) : (prices.cacheRead ?? null),
    output: prices.output,
    sourceUrl: provider === "openai" && model === "codex-auto-review" ? ""
             : provider === "openai" && model === "gpt-6-astra" ? PRICING_SOURCES.openaiGpt6Astra
             : provider === "openai" && model === "gpt-5.6-sol" ? PRICING_SOURCES.openaiGpt56
             : provider === "openai" ? PRICING_SOURCES.openai
             : provider === "omp" ? PRICING_SOURCES.omp
             : PRICING_SOURCES.anthropic,
  };
  row.id = pricingRowId(row);
  return row;
}

function packagedPricingRows() {
  const rows = [];
  for (const [model, entry] of Object.entries(PRICING.openai.models)) {
    if (Array.isArray(entry)) {
      for (const timed of entry) {
        for (const [variant, prices] of Object.entries(timed.prices)) {
          rows.push(rowFromPrices("openai", model, variant, prices, {
            effectiveFrom: timed.from,
            effectiveUntil: timed.until,
          }));
        }
      }
    } else {
      for (const [variant, prices] of Object.entries(entry)) {
        rows.push(rowFromPrices("openai", model, variant, prices));
      }
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
  for (const [model, entry] of Object.entries(PRICING.omp.models)) {
    if (Array.isArray(entry)) {
      for (const timed of entry) {
        rows.push(rowFromPrices("omp", model, "standard", timed.prices, {
          effectiveFrom: timed.from,
          effectiveUntil: timed.until,
        }));
      }
    } else {
      rows.push(rowFromPrices("omp", model, "standard", entry));
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
      pricingRevision: PACKAGED_CONFIGURATION_REVISION,
      regionalMultiplier: 1,
      monthlyCostLimitUsd: null,
      usageProfile: {
        id: "default",
        name: "Work API",
        mode: "api",
      },
    },
    prices: packagedPricingRows(),
  });
}

function normalizeUsageProfile(source) {
  const raw = source && typeof source === "object" ? source : {};
  const mode = String(raw.mode || "api").trim().toLowerCase();
  if (!new Set(["api", "subscription"]).has(mode)) {
    throw new Error("usageProfile mode must be api or subscription");
  }
  const defaultName = mode === "subscription" ? "Home Subscription" : "Work API";
  const name = String(raw.name ?? defaultName).trim();
  if (!name || name.length > 80) throw new Error("usageProfile name must be non-empty and at most 80 characters");
  const id = String(raw.id || "default").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    throw new Error("usageProfile id must be a lowercase identifier");
  }
  return { id, name, mode };
}

function normalizedPricingRevision(requestedRevision, pricingBasis) {
  if (pricingBasis === "custom") return requestedRevision;
  if (/^packaged-\d+$/.test(requestedRevision)) return PACKAGED_CONFIGURATION_REVISION;
  const managedMatch = requestedRevision.match(MANAGED_PACKAGED_REVISION_RE);
  if (managedMatch) {
    if (`packaged-${managedMatch[1]}` === PACKAGED_CONFIGURATION_REVISION) return requestedRevision;
    return `${PACKAGED_CONFIGURATION_REVISION}:managed:${createHash("sha256").update(requestedRevision).digest("hex").slice(0, 32)}`;
  }
  const derivedPattern = new RegExp(`^${PACKAGED_CONFIGURATION_REVISION}:[0-9a-f]{32}$`);
  if (derivedPattern.test(requestedRevision)) return requestedRevision;
  const digest = createHash("sha256").update(requestedRevision).digest("hex").slice(0, 32);
  return `${PACKAGED_CONFIGURATION_REVISION}:${digest}`;
}

function isDerivedPackagedPricingRevision(value) {
  return DERIVED_PACKAGED_REVISION_RE.test(String(value || "").trim());
}

function isManagedPackagedPricingRevision(value) {
  return MANAGED_PACKAGED_REVISION_RE.test(String(value || "").trim());
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

function comparablePricingRow(row) {
  return {
    provider: row.provider,
    model: row.model,
    matchMode: row.matchMode,
    variant: row.variant,
    effectiveFrom: row.effectiveFrom,
    effectiveUntil: row.effectiveUntil,
    input: row.input,
    cacheCreate5m: row.cacheCreate5m,
    cacheCreate30m: row.cacheCreate30m,
    cacheCreate1h: row.cacheCreate1h,
    cacheRead: row.cacheRead,
    output: row.output,
    sourceUrl: row.sourceUrl,
  };
}

function pricingCatalogSignature(sourceRows) {
  if (!Array.isArray(sourceRows)) return "";
  try {
    const rows = sourceRows
      .map((row, index) => JSON.stringify(comparablePricingRow(normalizePricingRow(row, index))))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return createHash("sha256").update(`[${rows.join(",")}]`).digest("hex");
  } catch {
    return "";
  }
}

function isLegacyPackagedPricingCatalog(sourceRows) {
  return packagedPricingCatalogRevision(sourceRows) === LEGACY_PACKAGED_CONFIGURATION_REVISION;
}

function isCurrentPackagedPricingCatalog(sourceRows) {
  return packagedPricingCatalogRevision(sourceRows) === PACKAGED_CONFIGURATION_REVISION;
}

function packagedPricingCatalogRevision(sourceRows) {
  const signature = pricingCatalogSignature(sourceRows);
  if (signature === LEGACY_PACKAGED_3_CATALOG_SIGNATURE ||
      signature === LEGACY_PACKAGED_3_CLICKHOUSE_CATALOG_SIGNATURE) {
    return LEGACY_PACKAGED_CONFIGURATION_REVISION;
  }
  if (signature === PACKAGED_4_CATALOG_SIGNATURE || signature === PACKAGED_4_CLICKHOUSE_CATALOG_SIGNATURE) {
    return "packaged-4";
  }
  if (signature === PACKAGED_5_CATALOG_SIGNATURE || signature === PACKAGED_5_CLICKHOUSE_CATALOG_SIGNATURE) {
    return "packaged-5";
  }
  return "";
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
  const requestedPricingRevision = String(rawSettings.pricingRevision || revision).trim();
  const packagedManagedPricing = pricingBasis === "standard" &&
    (!requestedPricingRevision || /^packaged-\d+$/.test(requestedPricingRevision) || isManagedPackagedPricingRevision(requestedPricingRevision));
  const pricingRevision = normalizedPricingRevision(requestedPricingRevision, pricingBasis);
  if (!pricingRevision || pricingRevision.length > 160) {
    throw new Error("pricingRevision must be a non-empty string");
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
  const usageProfile = normalizeUsageProfile(rawSettings.usageProfile);
  if (usageProfile.mode !== "api" && monthlyCostLimitUsd !== null) {
    throw new Error("monthlyCostLimitUsd is only supported for API profiles");
  }
  if (!Array.isArray(source.prices) || source.prices.length === 0 || source.prices.length > 1_000) {
    throw new Error("configuration prices must contain between 1 and 1000 rows");
  }
  const normalizedSourcePrices = source.prices.map(normalizePricingRow);
  const packagedRows = packagedManagedPricing ? packagedPricingRows() : null;
  if (packagedRows && requestedPricingRevision !== PACKAGED_CONFIGURATION_REVISION) {
    migrateLegacyTimedPackagedRows(normalizedSourcePrices, packagedRows);
  }
  const sourceIds = new Set();
  for (const row of normalizedSourcePrices) {
    if (sourceIds.has(row.id)) throw new Error(`duplicate pricing row: ${row.id}`);
    sourceIds.add(row.id);
  }
  if (packagedManagedPricing) {
    const rowsById = new Map(normalizedSourcePrices.map((row) => [row.id, row]));
    for (const [index, sourceRow] of packagedRows.entries()) {
      const row = normalizePricingRow(sourceRow, normalizedSourcePrices.length + index);
      if (!rowsById.has(row.id)) rowsById.set(row.id, row);
    }
    normalizedSourcePrices.splice(0, normalizedSourcePrices.length, ...rowsById.values());
  } else if (pricingBasis === "standard") {
    const autoReviewSource = packagedPricingRows().find((row) => (
      row.provider === "openai" && row.model === "codex-auto-review"
    ));
    const autoReview = normalizePricingRow(autoReviewSource, normalizedSourcePrices.length);
    if (!sourceIds.has(autoReview.id)) normalizedSourcePrices.push(autoReview);
  }
  const prices = normalizedSourcePrices
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
    settings: { openaiContext, pricingBasis, pricingRevision, regionalMultiplier, monthlyCostLimitUsd, usageProfile },
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
    pricingRevision: normalized.settings.pricingRevision,
  };
}

function pricingConfigurationSignature(configuration) {
  const normalized = normalizeConfiguration(configuration);
  return JSON.stringify({
    openaiContext: normalized.settings.openaiContext,
    pricingBasis: normalized.settings.pricingBasis,
    regionalMultiplier: normalized.settings.regionalMultiplier,
    prices: normalized.prices,
  });
}

module.exports = {
  LEGACY_PACKAGED_CONFIGURATION_REVISION,
  PACKAGED_CONFIGURATION_REVISION,
  PRICE_FIELDS,
  defaultConfiguration,
  isCurrentPackagedPricingCatalog,
  isDerivedPackagedPricingRevision,
  isLegacyPackagedPricingCatalog,
  isManagedPackagedPricingRevision,
  normalizeConfiguration,
  normalizeUsageProfile,
  packagedPricingCatalogRevision,
  packagedPricingRows,
  pricingOptionsFromConfiguration,
  pricingConfigurationSignature,
  pricingRowId,
};
