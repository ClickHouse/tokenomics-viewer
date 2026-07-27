"use strict";

const fsp = require("node:fs/promises");
const Path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { addUsage } = require("../core/aggregate");
const {
  UNKNOWN_EFFORT,
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
  addToStats,
  newStats,
} = require("../core/report-model");

const UNKNOWN_SERVICE_MODE = "unknown";
const OPENCODE_AGENT = "opencode";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith(`~${Path.sep}`)) {
    return Path.join(home, value.slice(2));
  }
  return value;
}

function sqliteText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value);
}

function tokenNumber(value) {
  const parsed = typeof value === "number"
    ? value
    : (typeof value === "string" && value.trim() !== "" ? Number(value) : 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function timestampFromSql(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) {
    // OpenCode stores milliseconds. Accept seconds as a harmless fixture/
    // migration compatibility fallback without changing normal DB values.
    return new Date(Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric);
  }
  return new Date(value);
}

function parseError(report, session, filename, rowNo, error, options) {
  if (report.sources) report.sources.parseErrors = (report.sources.parseErrors || 0) + 1;
  if (session) session.parseErrors = (session.parseErrors || 0) + 1;
  if (!options?.strictJson) return;

  const suffix = rowNo == null ? "" : `:${rowNo}`;
  const reason = error && error.message ? `: ${error.message}` : "";
  throw new Error(`Malformed OpenCode data in ${filename}${suffix}${reason}`);
}

function openCodeDataRoot(home) {
  const dataBase = nonEmptyString(process.env.XDG_DATA_HOME)
    ? Path.resolve(expandHome(process.env.XDG_DATA_HOME, home))
    : Path.join(home, ".local", "share");
  return nonEmptyString(process.env.OPENCODE_DATA_DIR)
    ? Path.resolve(expandHome(process.env.OPENCODE_DATA_DIR, home))
    : Path.join(dataBase, "opencode");
}

/**
 * Discover OpenCode's SQLite stores without opening or mutating them.
 *
 * The input kind deliberately remains `jsonl` for the historical ingest
 * dispatcher; the processing path identifies the `.db` representation and
 * creates a `session.kind === "db"` record.
 */
async function discoverOpenCodeInputs(home) {
  const resolvedHome = Path.resolve(home || process.env.HOME || ".");
  const root = openCodeDataRoot(resolvedHome);
  const prefix = nonEmptyString(process.env.OPENCODE_DB_PREFIX) || "opencode";
  let files;
  try {
    files = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return files
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".db"))
    .map((entry) => ({
      kind: "jsonl",
      adapter: OPENCODE_AGENT,
      path: Path.join(root, entry.name),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function isOpenCodeDbPath(filename) {
  return typeof filename === "string" && Path.extname(filename).toLowerCase() === ".db";
}

function projectForSession(row) {
  return nonEmptyString(sqliteText(row.directory)) ||
    nonEmptyString(sqliteText(row.title)) ||
    UNKNOWN_PROJECT;
}

function usageFromMessageData(data) {
  // OpenCode's SQLite message.data contract is the nested `tokens` object.
  // Do not infer from provider-reported cost or alternate usage fields: the
  // normal pricing path must recompute the amount from these exact buckets.
  const tokens = data && typeof data.tokens === "object" && data.tokens !== null
    ? data.tokens
    : {};
  const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
  return {
    input: tokenNumber(tokens.input),
    cacheCreate5m: tokenNumber(cache.write),
    cacheRead: tokenNumber(cache.read),
    output: tokenNumber(tokens.output),
    reasoningOutput: tokenNumber(tokens.reasoning),
    inputIncludesCacheRead: false,
  };
}

function processOpenCodeDb(filename, report, options = {}, session) {
  if (session) session.kind = "db";
  let db;
  try {
    // This adapter is intentionally read-only. In particular, do not issue
    // PRAGMA writes or migrations against a user's active OpenCode database.
    db = new DatabaseSync(filename, { readOnly: true });
  } catch (error) {
    parseError(report, session, filename, null, error, options);
    return;
  }

  try {
    let topLevelSessions;
    try {
      topLevelSessions = db.prepare(`
        SELECT id, CAST(directory AS BLOB) AS directory, CAST(title AS BLOB) AS title
        FROM session
        WHERE parent_id IS NULL AND time_archived IS NULL
        ORDER BY time_created ASC, id ASC
      `).all();
    } catch (error) {
      parseError(report, session, filename, null, error, options);
      return;
    }

    if (session) session.lines = topLevelSessions.length;
    if (topLevelSessions.length === 0) return;

    const projects = new Map(
      topLevelSessions.map((row) => [String(row.id), projectForSession(row)]),
    );

    let messages;
    try {
      // Join against the same top-level predicate instead of interpolating a
      // potentially large IN list. Child and archived sessions are excluded
      // even when their messages remain in the DB.
      messages = db.prepare(`
        SELECT m.id, m.session_id, m.time_created, CAST(m.data AS BLOB) AS data
        FROM message AS m
        JOIN session AS s ON s.id = m.session_id
        WHERE s.parent_id IS NULL AND s.time_archived IS NULL
        ORDER BY m.time_created ASC, m.id ASC
      `).all();
    } catch (error) {
      parseError(report, session, filename, null, error, options);
      return;
    }

    for (const row of messages) {
      if (session) session.records = (session.records || 0) + 1;
      const rowNo = session?.records || null;
      let data;
      try {
        data = JSON.parse(sqliteText(row.data));
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new Error("message.data must be an object");
        }
      } catch (error) {
        parseError(report, session, filename, rowNo, error, options);
        continue;
      }

      if (data.role !== "assistant" && data.role !== "model") continue;
      const usage = usageFromMessageData(data);
      if (
        usage.input === 0 &&
        usage.cacheCreate5m === 0 &&
        usage.cacheRead === 0 &&
        usage.output === 0 &&
        usage.reasoningOutput === 0
      ) continue;

      const provider = nonEmptyString(data.providerID) || OPENCODE_AGENT;
      const model = nonEmptyString(data.modelID) || UNKNOWN_MODEL;
      const added = addUsage(report, {
        provider,
        model,
        project: projects.get(String(row.session_id)) || UNKNOWN_PROJECT,
        effort: UNKNOWN_EFFORT,
        serviceMode: UNKNOWN_SERVICE_MODE,
        agent: OPENCODE_AGENT,
        timestamp: timestampFromSql(row.time_created),
        usage,
        sourcePath: session?.path || filename,
        lineNo: rowNo,
      }, options);
      if (session) {
        if (!session.stats) session.stats = newStats();
        addToStats(session.stats, added.usage, added.cost);
      }
    }
  } finally {
    db.close();
  }
}

module.exports = {
  discoverOpenCodeInputs,
  isOpenCodeDbPath,
  processOpenCodeDb,
};
