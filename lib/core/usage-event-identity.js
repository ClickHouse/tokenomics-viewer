"use strict";

const { createHash } = require("node:crypto");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function value(row, camel, snake = camel) {
  return row?.[camel] ?? row?.[snake] ?? null;
}

function usageEventKey(row, defaultSourcePath = null) {
  const provider = String(value(row, "provider") || "unknown");
  const requestId = value(row, "requestId", "request_id");
  const storedKey = value(row, "eventKey", "event_key");
  const normalizedRequestId = typeof requestId === "string" && requestId
    ? requestId
    : (typeof storedKey === "string" && storedKey.startsWith("request:")
      ? storedKey.slice("request:".length)
      : null);
  if (normalizedRequestId) return `request:${provider}:${normalizedRequestId}`;

  const sourcePath = value(row, "sourcePath", "source_path") || defaultSourcePath || "unknown";
  const lineNo = value(row, "lineNo", "line_no");
  const fallback = typeof storedKey === "string" && storedKey ? storedKey : `line:${lineNo ?? "unknown"}`;
  return `source:${sourcePath}:${fallback}`;
}

function usagePayload(row) {
  const usage = row?.usage || {};
  const visibleChars = row?.visibleChars || {};
  return {
    // A response can be copied into a continuation log with a new envelope
    // timestamp. Compare the response contents, not the copy location/time.
    provider: value(row, "provider"),
    model: value(row, "model"),
    project: value(row, "project"),
    effort: value(row, "effort"),
    serviceTier: value(row, "serviceTier", "service_tier"),
    serviceMode: value(row, "serviceMode", "service_mode"),
    agent: value(row, "agent"),
    usage: {
      input: usage.input ?? value(row, "input") ?? 0,
      cacheCreate5m: usage.cacheCreate5m ?? value(row, "cacheCreate5m", "cache_create_5m") ?? 0,
      cacheCreate30m: usage.cacheCreate30m ?? value(row, "cacheCreate30m", "cache_create_30m") ?? 0,
      cacheCreate1h: usage.cacheCreate1h ?? value(row, "cacheCreate1h", "cache_create_1h") ?? 0,
      cacheRead: usage.cacheRead ?? value(row, "cacheRead", "cache_read") ?? 0,
      output: usage.output ?? value(row, "output") ?? 0,
      reasoningOutput: usage.reasoningOutput ?? value(row, "reasoningOutput", "reasoning_output") ?? 0,
      contextWindow: usage.contextWindow ?? value(row, "contextWindow", "context_window") ?? 0,
    },
    visibleChars: {
      input: visibleChars.input ?? value(row, "visibleInputChars", "visible_input_chars") ?? 0,
      output: visibleChars.output ?? value(row, "visibleOutputChars", "visible_output_chars") ?? 0,
      total: visibleChars.total ?? value(row, "visibleTotalChars", "visible_total_chars") ?? 0,
    },
  };
}

function usagePayloadHash(row) {
  return sha256(canonicalJson(usagePayload(row)));
}

function diagnosticEventKey(key) {
  return sha256(key).slice(0, 16);
}

module.exports = {
  canonicalJson,
  diagnosticEventKey,
  sha256,
  usageEventKey,
  usagePayload,
  usagePayloadHash,
};
