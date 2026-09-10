"use strict";

// Bump these independently when their derived values can change for the same source bytes.
const ANALYTICS_DERIVATION_VERSION = 8;
// Keep parser-owned revisions separate from the shared analytics counter. Two
// parallel changes can otherwise choose the same next integer and accidentally
// make an old source look current after both branches merge.
const CODEX_USAGE_DERIVATION_VERSION = 2;

function sourceFingerprint(parts, {
  analyticsDerivationVersion = ANALYTICS_DERIVATION_VERSION,
  codexUsageDerivationVersion = CODEX_USAGE_DERIVATION_VERSION,
} = {}) {
  const {
    pricingCatalogVersion: _legacyPricingCatalogVersion,
    pricingRevision: _pricingRevision,
    ...sourceParts
  } = parts;
  return Object.entries({
    ...sourceParts,
    analyticsDerivationVersion,
    codexUsageDerivationVersion,
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

function analyticsDerivationVersionFromFingerprint(fingerprint) {
  return derivationVersionFromFingerprint(fingerprint, "analyticsDerivationVersion");
}

function codexUsageDerivationVersionFromFingerprint(fingerprint) {
  return derivationVersionFromFingerprint(fingerprint, "codexUsageDerivationVersion");
}

function derivationVersionFromFingerprint(fingerprint, key) {
  const prefix = key + "=";
  const part = String(fingerprint || "")
    .split("|")
    .find((candidate) => candidate.startsWith(prefix));
  if (!part) return null;
  const value = Number(part.slice(prefix.length));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sameAnalyticsDerivation(left, right) {
  const leftAnalytics = analyticsDerivationVersionFromFingerprint(left);
  const rightAnalytics = analyticsDerivationVersionFromFingerprint(right);
  const leftCodexUsage = codexUsageDerivationVersionFromFingerprint(left);
  const rightCodexUsage = codexUsageDerivationVersionFromFingerprint(right);
  return leftAnalytics !== null
    && leftAnalytics === rightAnalytics
    && leftCodexUsage !== null
    && leftCodexUsage === rightCodexUsage;
}

module.exports = {
  ANALYTICS_DERIVATION_VERSION,
  CODEX_USAGE_DERIVATION_VERSION,
  analyticsDerivationVersionFromFingerprint,
  canonicalSourceFingerprint,
  codexUsageDerivationVersionFromFingerprint,
  sameAnalyticsDerivation,
  sameSourceFingerprint,
  sourceFingerprint,
};
