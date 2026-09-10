"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  ANALYTICS_DERIVATION_VERSION,
  CODEX_USAGE_DERIVATION_VERSION,
  sameAnalyticsDerivation,
  sameSourceFingerprint,
  sourceFingerprint,
} = require("../lib/core/derivation");

const sourceParts = {
  size: 128,
  kind: "jsonl",
  mtimeMs: 42,
};

test("source fingerprints use deterministic key ordering", () => {
  const first = sourceFingerprint(sourceParts);
  const second = sourceFingerprint({
    mtimeMs: sourceParts.mtimeMs,
    kind: sourceParts.kind,
    size: sourceParts.size,
  });

  assert.equal(first, second);
  assert.equal(first, [
    `analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`,
    `codexUsageDerivationVersion=${CODEX_USAGE_DERIVATION_VERSION}`,
    "kind=jsonl",
    "mtimeMs=42",
    "size=128",
  ].join("|"));
});

test("Codex usage derivation invalidates a colliding global analytics version", () => {
  const current = sourceFingerprint(sourceParts);
  const previous = current
    .split("|")
    .filter((part) => !part.startsWith("codexUsageDerivationVersion="))
    .join("|");

  assert.equal(
    previous.includes(`analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`),
    true,
  );
  assert.equal(sameAnalyticsDerivation(previous, current), false);
  assert.equal(sameSourceFingerprint(previous, current), false);
  assert.equal(sameAnalyticsDerivation(current, current), true);
});

test("source fingerprints invalidate when the analytics derivation changes", () => {
  const current = sourceFingerprint(sourceParts);
  const analyticsChanged = sourceFingerprint(sourceParts, {
    analyticsDerivationVersion: ANALYTICS_DERIVATION_VERSION + 1,
  });
  assert.notEqual(analyticsChanged, current);
  assert.match(current, new RegExp(`analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`));
});

test("source fingerprints ignore database pricing revisions", () => {
  const first = sourceFingerprint({ ...sourceParts, pricingRevision: "catalog-a" });
  const second = sourceFingerprint({ ...sourceParts, pricingRevision: "catalog-b" });

  assert.equal(first, second);
  assert.doesNotMatch(first, /pricingRevision=/);
});

test("legacy pricing fingerprint fields do not force a source reimport", () => {
  const current = sourceFingerprint(sourceParts);
  const legacy = `${current}|pricingCatalogVersion=1|pricingRevision=catalog-a`;

  assert.equal(sameSourceFingerprint(legacy, current), true);
});
