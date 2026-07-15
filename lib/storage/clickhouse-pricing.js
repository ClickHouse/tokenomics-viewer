"use strict";

const { normalizeConfiguration } = require("../core/configuration");

const CLICKHOUSE_COST_COLUMNS = [
  "priced",
  "cost_usd",
  "reasoning_cost_usd",
  "cost_input_usd",
  "cost_cache_create_5m_usd",
  "cost_cache_create_30m_usd",
  "cost_cache_create_1h_usd",
  "cost_cache_read_usd",
  "cost_output_usd",
];

function encodedString(value) {
  return `base64Decode('${Buffer.from(String(value), "utf8").toString("base64")}')`;
}

function nullableFloat(value) {
  return value === null || value === undefined
    ? "CAST(NULL AS Nullable(Float64))"
    : `toNullable(toFloat64(${Number(value)}))`;
}

function pricingTuple(row) {
  return `tuple(${[
    row.input,
    row.cacheCreate5m,
    row.cacheCreate30m,
    row.cacheCreate1h,
    row.cacheRead,
    row.output,
  ].map(nullableFloat).join(", ")})`;
}

function rowMatchExpression(row, expressions) {
  const provider = encodedString(row.provider);
  const model = encodedString(row.model);
  const providerMatches = `${expressions.provider} = ${provider}`;
  let modelMatches = `${expressions.model} = ${model}`;
  if (row.matchMode === "prefix") {
    modelMatches = `(${modelMatches} OR startsWith(${expressions.model}, concat(${model}, '-')))`;
  } else if (row.matchMode === "snapshot") {
    const suffix = `substringUTF8(${expressions.model}, lengthUTF8(${model}) + 2)`;
    modelMatches = `(${modelMatches} OR (startsWith(${expressions.model}, concat(${model}, '-')) AND match(${suffix}, '^\\d{4}-\\d{2}-\\d{2}$')))`;
  }
  const dates = [];
  if (row.effectiveFrom) dates.push(`${expressions.timestamp} >= parseDateTime64BestEffort(${encodedString(row.effectiveFrom)})`);
  if (row.effectiveUntil) dates.push(`${expressions.timestamp} <= parseDateTime64BestEffort(${encodedString(row.effectiveUntil)})`);
  return `(${[providerMatches, modelMatches, ...dates].join(" AND ")})`;
}

function buildClickHouseCostProjection(sourceConfiguration, sourceExpressions = {}) {
  const configuration = normalizeConfiguration(sourceConfiguration);
  const alias = sourceExpressions.alias || "raw";
  const expressions = {
    provider: sourceExpressions.provider || `lowerUTF8(trimBoth(toString(${alias}.provider)))`,
    model: sourceExpressions.model || `lowerUTF8(trimBoth(toString(${alias}.model)))`,
    timestamp: sourceExpressions.timestamp
      ? sourceExpressions.timestampIsDateTime
        ? sourceExpressions.timestamp
        : `ifNull(parseDateTime64BestEffortOrNull(toString(${sourceExpressions.timestamp})), now64(3))`
      : "now64(3)",
    input: sourceExpressions.input || `${alias}.input`,
    cacheCreate5m: sourceExpressions.cacheCreate5m || `${alias}.cache_create_5m`,
    cacheCreate30m: sourceExpressions.cacheCreate30m || `${alias}.cache_create_30m`,
    cacheCreate1h: sourceExpressions.cacheCreate1h || `${alias}.cache_create_1h`,
    cacheRead: sourceExpressions.cacheRead || `${alias}.cache_read`,
    output: sourceExpressions.output || `${alias}.output`,
    reasoningOutput: sourceExpressions.reasoningOutput || `${alias}.reasoning_output`,
  };
  const rows = configuration.prices
    .map((row) => ({ row, matches: rowMatchExpression(row, expressions) }))
    .sort((left, right) => right.row.model.length - left.row.model.length);
  const longMatches = rows
    .filter(({ row }) => row.provider === "openai" && row.variant === "long")
    .map(({ matches }) => matches);
  const hasLong = longMatches.length ? `(${longMatches.join(" OR ")})` : "false";
  const inputTokens = [
    expressions.input,
    expressions.cacheCreate5m,
    expressions.cacheCreate30m,
    expressions.cacheCreate1h,
    expressions.cacheRead,
  ].join(" + ");
  const contextWantsLong = configuration.settings.openaiContext === "long"
    ? "true"
    : configuration.settings.openaiContext === "auto"
      ? `((${inputTokens}) > 272000)`
      : "false";
  const useLong = `${alias}.use_long_price`;
  const preferred = rows.filter(({ row }) => (
    row.provider === "openai" && (row.variant === "short" || row.variant === "long")
  )).map(({ row, matches }) => ({
    row,
    condition: row.variant === "long"
      ? `(${matches} AND ${useLong})`
      : `(${matches} AND NOT ${useLong})`,
  }));
  const standard = rows
    .filter(({ row }) => row.variant === "standard")
    .map(({ row, matches }) => ({ row, condition: matches }));
  const candidates = [...preferred, ...standard];
  const emptyTuple = `tuple(${Array.from({ length: 6 }, () => "CAST(NULL AS Nullable(Float64))").join(", ")})`;
  const pairs = candidates.flatMap(({ row, condition }) => [condition, pricingTuple(row)]);
  const matchExpression = `multiIf(${[...pairs, emptyTuple].join(", ")})`;

  const price = (index) => `tupleElement(matched_prices, ${index})`;
  const known = `isNotNull(${price(1)})`;
  const multiplier = Number(configuration.settings.regionalMultiplier);
  const amount = (tokens, unitPrice) => `if(${known}, toFloat64(${tokens}) * ifNull(${unitPrice}, 0) * ${multiplier} / 1000000, 0)`;
  const costs = {
    input: amount(expressions.input, price(1)),
    cacheCreate5m: amount(expressions.cacheCreate5m, price(2)),
    cacheCreate30m: amount(expressions.cacheCreate30m, price(3)),
    cacheCreate1h: amount(expressions.cacheCreate1h, price(4)),
    cacheRead: amount(expressions.cacheRead, `ifNull(${price(5)}, ${price(1)})`),
    output: amount(expressions.output, price(6)),
    reasoning: amount(`least(${expressions.reasoningOutput}, ${expressions.output})`, price(6)),
  };
  const total = Object.values(costs).slice(0, 6).map((value) => `(${value})`).join(" + ");
  const projection = [
    `toUInt8(${known}) AS priced`,
    `${total} AS cost_usd`,
    `${costs.reasoning} AS reasoning_cost_usd`,
    `${costs.input} AS cost_input_usd`,
    `${costs.cacheCreate5m} AS cost_cache_create_5m_usd`,
    `${costs.cacheCreate30m} AS cost_cache_create_30m_usd`,
    `${costs.cacheCreate1h} AS cost_cache_create_1h_usd`,
    `${costs.cacheRead} AS cost_cache_read_usd`,
    `${costs.output} AS cost_output_usd`,
  ].join(",\n        ");

  return {
    hasLongExpression: hasLong,
    matchExpression,
    projection,
    useLongExpression: `(toUInt8(${alias}.has_long_price) = 1 AND (${contextWantsLong}))`,
  };
}

module.exports = {
  CLICKHOUSE_COST_COLUMNS,
  buildClickHouseCostProjection,
};
