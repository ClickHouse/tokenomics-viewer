"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { defaultConfiguration } = require("../lib/core/configuration");
const { buildClickHouseCostProjection } = require("../lib/storage/clickhouse-pricing");

test("ClickHouse pricing projection derives every cost bucket from normalized usage", () => {
  const sql = buildClickHouseCostProjection(defaultConfiguration(), {
    alias: "raw",
    timestamp: "raw.timestamp",
  });

  assert.match(sql.matchExpression, /multiIf\(/);
  assert.match(sql.hasLongExpression, /base64Decode\('/);
  assert.match(sql.useLongExpression, /272000/);
  assert.match(sql.projection, /AS cost_input_usd/);
  assert.match(sql.projection, /AS cost_cache_read_usd/);
  assert.match(sql.projection, /AS cost_output_usd/);
  assert.match(sql.projection, /AS reasoning_cost_usd/);
});

test("ClickHouse pricing projection encodes editable model ids as data", () => {
  const configuration = defaultConfiguration();
  configuration.prices[0].model = "model-'quoted";
  const sql = buildClickHouseCostProjection(configuration, { alias: "raw" });

  assert.doesNotMatch(sql.matchExpression, /model-'quoted/);
  assert.match(sql.matchExpression, /base64Decode\('/);
});

test("ClickHouse pricing projection applies packaged fast multipliers from service_tier", () => {
  const sql = buildClickHouseCostProjection(defaultConfiguration(), { alias: "raw" });

  assert.match(sql.projection, /raw\.service_tier/);
  assert.match(sql.projection, /= 'priority'/);
  assert.match(sql.projection, /= 'fast'/);
  assert.match(sql.projection, /2\.5/);
  assert.match(sql.projection, /Z3B0LTYtYXN0cmE=/);
  assert.match(sql.projection, /, 2,/);

  const custom = defaultConfiguration();
  custom.settings.pricingBasis = "custom";
  custom.settings.pricingRevision = "custom-fast-test";
  const customSql = buildClickHouseCostProjection(custom, { alias: "raw" });
  assert.doesNotMatch(customSql.projection, /raw\.service_tier/);
});

test("ClickHouse pricing projection uses canonical service_mode for Anthropic fast pricing", () => {
  const sql = buildClickHouseCostProjection(defaultConfiguration(), { alias: "raw" });

  assert.match(sql.projection, /raw\.service_mode/);
  assert.match(sql.projection, /'anthropic'/);
  assert.match(sql.projection, /Y2xhdWRlLW9wdXMtNQ==/);
  assert.match(sql.projection, /Y2xhdWRlLW9wdXMtNC04/);
  assert.match(sql.projection, /, 2,/);

  const custom = defaultConfiguration();
  custom.settings.pricingBasis = "custom";
  const customSql = buildClickHouseCostProjection(custom, { alias: "raw" });
  assert.doesNotMatch(customSql.projection, /raw\.service_mode/);
});
