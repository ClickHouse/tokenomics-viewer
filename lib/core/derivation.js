"use strict";

// Bump these independently when their derived values can change for the same source bytes.
const ANALYTICS_DERIVATION_VERSION = 1;

function sourceFingerprint(parts, {
  analyticsDerivationVersion = ANALYTICS_DERIVATION_VERSION,
} = {}) {
  const {
    pricingCatalogVersion: _legacyPricingCatalogVersion,
    pricingRevision: _pricingRevision,
    ...sourceParts
  } = parts;
  return Object.entries({
    ...sourceParts,
    analyticsDerivationVersion,
  })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => String(key) + "=" + (value ?? ""))
    .join("|");
}

function canonicalSourceFingerprint(fingerprint) {
  return String(fingerprint || "")
    .split("|")
    .filter((part) => !part.startsWith("pricingCatalogVersion=") && !part.startsWith("pricingRevision="))
    .sort()
    .join("|");
}

function sameSourceFingerprint(left, right) {
  return canonicalSourceFingerprint(left) === canonicalSourceFingerprint(right);
}

module.exports = {
  ANALYTICS_DERIVATION_VERSION,
  canonicalSourceFingerprint,
  sameSourceFingerprint,
  sourceFingerprint,
};
