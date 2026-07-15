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
