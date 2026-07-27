"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const {
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
} = require("../core/report-model");

const OBSERVED_MEASUREMENT = "observed-only";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nonNegativeNumber(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith(`~${Path.sep}`)) return Path.join(home, value.slice(2));
  return value;
}

async function walkFiles(root, predicate, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = Path.join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, predicate, out);
    else if (entry.isFile() && predicate(fullPath)) out.push(fullPath);
  }
  return out;
}

function observedSourceError(report, session, filename, error, options) {
  report.sources.parseErrors += 1;
  if (session) session.parseErrors += 1;
  if (!options.strictJson) return;
  const reason = error && error.message ? `: ${error.message}` : "";
  throw new Error(`Invalid JSON in ${filename}${reason}`);
}

function isoTimestamp(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function observationBase({ agent, provider, model, project, sourceTimestamp, sourceTimestampProvenance }) {
  return {
    agent: nonEmptyString(agent) || "unknown",
    provider: nonEmptyString(provider) || "unknown",
    model: nonEmptyString(model) || UNKNOWN_MODEL,
    project: nonEmptyString(project) || UNKNOWN_PROJECT,
    measurement: OBSERVED_MEASUREMENT,
    exactUsageAvailable: false,
    sourceTimestamp: sourceTimestamp || null,
    sourceTimestampProvenance: sourceTimestampProvenance || "unknown",
  };
}

function cursorProject(filename) {
  const normalized = filename.replace(/\\/g, "/");
  const match = normalized.match(/\/\.cursor\/projects\/([^/]+)\/agent-transcripts(?:\/|$)/);
  return nonEmptyString(match?.[1]) || UNKNOWN_PROJECT;
}

function cursorRoot(home) {
  const override = nonEmptyString(process.env.CURSOR_DATA_DIR) || nonEmptyString(process.env.CURSOR_HOME);
  return Path.join(Path.resolve(expandHome(override || Path.join(home, ".cursor"), home)), "projects");
}

async function discoverCursorInputs(home) {
  const paths = await walkFiles(cursorRoot(home), (filename) => {
    const normalized = filename.replace(/\\/g, "/");
    return filename.endsWith(".jsonl") && normalized.includes("/agent-transcripts/");
  });
  return paths.map((path) => ({ kind: "jsonl", adapter: "cursor", path }));
}

function grokRoot(home) {
  const override = nonEmptyString(process.env.GROK_DATA_DIR) || nonEmptyString(process.env.GROK_HOME);
  return Path.join(Path.resolve(expandHome(override || Path.join(home, ".grok"), home)), "sessions");
}

async function discoverGrokInputs(home) {
  const paths = await walkFiles(grokRoot(home), (filename) => Path.basename(filename) === "updates.jsonl");
  return paths.map((path) => ({ kind: "jsonl", adapter: "grok", path }));
}

function projectFromGrokSummary(summary, encodedProject) {
  const direct = nonEmptyString(summary?.info?.cwd) ||
    nonEmptyString(summary?.cwd) ||
    nonEmptyString(summary?.git_root_dir);
  if (direct) return direct;
  try {
    const decoded = decodeURIComponent(encodedProject || "");
    return nonEmptyString(decoded) || UNKNOWN_PROJECT;
  } catch {
    return nonEmptyString(encodedProject) || UNKNOWN_PROJECT;
  }
}

function grokTimestamp(summary) {
  const fields = [
    ["updated_at", summary?.updated_at ?? summary?.updatedAt],
    ["last_active_at", summary?.last_active_at ?? summary?.lastActiveAt],
    ["created_at", summary?.created_at ?? summary?.createdAt],
  ];
  for (const [field, value] of fields) {
    const timestamp = isoTimestamp(value);
    if (timestamp) return { timestamp, provenance: `summary.${field}` };
  }
  return { timestamp: null, provenance: "summary.timestamp-unavailable" };
}

function grokModel(summary, signals) {
  return nonEmptyString(summary?.current_model_id ?? summary?.currentModelId) ||
    nonEmptyString(summary?.primary_model_id ?? summary?.primaryModelId) ||
    nonEmptyString(summary?.model_id ?? summary?.modelId) ||
    nonEmptyString(signals?.primaryModelId) ||
    nonEmptyString(signals?.modelId) ||
    UNKNOWN_MODEL;
}

async function readJsonMetadata(filename, report, session, options) {
  let value;
  try {
    value = JSON.parse(await fsp.readFile(filename, "utf8"));
  } catch (error) {
    observedSourceError(report, session, filename, error, options);
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    observedSourceError(report, session, filename, new Error("metadata must be an object"), options);
    return null;
  }
  return value;
}

async function processCursorObserved(filename, report, options, session) {
  let stat;
  try {
    stat = await fsp.stat(filename);
  } catch (error) {
    observedSourceError(report, session, filename, error, options);
    return;
  }
  // Cursor transcript JSONL has no trustworthy per-session model or event
  // timestamp fields. Do not parse its conversation content and do not infer a
  // model from the global CLI config; only path and mtime are admissible here.
  session.stats.observation = observationBase({
    agent: "cursor-agent",
    provider: "cursor",
    model: UNKNOWN_MODEL,
    project: cursorProject(filename),
    sourceTimestamp: Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs).toISOString() : null,
    sourceTimestampProvenance: "fileModifiedAt",
  });
}

async function processGrokObserved(filename, report, options, session) {
  const sessionDir = Path.dirname(filename);
  const summaryPath = Path.join(sessionDir, "summary.json");
  const signalsPath = Path.join(sessionDir, "signals.json");
  const summary = await readJsonMetadata(summaryPath, report, session, options);
  if (!summary) return;

  let signals = null;
  try {
    await fsp.access(signalsPath, fs.constants.R_OK);
  } catch {
    // Signals are optional for a completed session; absence is not a zero.
  }
  if (fs.existsSync(signalsPath)) signals = await readJsonMetadata(signalsPath, report, session, options);
  if (options.strictJson && session.parseErrors > 0) return;

  const encodedProject = Path.basename(Path.dirname(sessionDir));
  const sourceTimestamp = grokTimestamp(summary);
  const observation = observationBase({
    agent: "grok-build",
    provider: "grok",
    model: grokModel(summary, signals),
    project: projectFromGrokSummary(summary, encodedProject),
    sourceTimestamp: sourceTimestamp.timestamp,
    sourceTimestampProvenance: sourceTimestamp.provenance,
  });
  const contextTokens = nonNegativeNumber(signals?.contextTokensUsed);
  const contextWindowTokens = nonNegativeNumber(signals?.contextWindowTokens);
  if (contextTokens !== null) observation.contextTokens = contextTokens;
  if (contextWindowTokens !== null) observation.contextWindowTokens = contextWindowTokens;
  session.stats.observation = observation;
}

function adapterForObservedPath(filename, hint = null) {
  if (hint === "cursor" || hint === "grok") return hint;
  const normalized = filename.replace(/\\/g, "/");
  if (normalized.includes("/.cursor/projects/") && normalized.includes("/agent-transcripts/")) return "cursor";
  if (Path.basename(filename) === "updates.jsonl" && normalized.includes("/.grok/sessions/")) return "grok";
  return null;
}

async function processObservedHarnessFile(filename, report, options, session, hint = null) {
  const adapter = adapterForObservedPath(filename, hint);
  if (adapter === "cursor") return processCursorObserved(filename, report, options, session);
  if (adapter === "grok") return processGrokObserved(filename, report, options, session);
  return false;
}

module.exports = {
  OBSERVED_MEASUREMENT,
  adapterForObservedPath,
  discoverCursorInputs,
  discoverGrokInputs,
  processObservedHarnessFile,
};
