"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const { addUsage } = require("../core/aggregate");
const {
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
  UNKNOWN_EFFORT,
  addToStats,
  number,
} = require("../core/report-model");
const {
  discoverOpenCodeInputs,
  processOpenCodeDb,
} = require("./opencode");
const {
  discoverCursorInputs,
  discoverGrokInputs,
  processObservedHarnessFile,
} = require("./observed-harnesses");

const UNKNOWN_SERVICE_MODE = "unknown";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function numeric(value) {
  const parsed = number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith(`~${Path.sep}`)) {
    return Path.join(home, value.slice(2));
  }
  return value;
}

async function realPathOrResolve(path) {
  try {
    return await fsp.realpath(path);
  } catch {
    return Path.resolve(path);
  }
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
    if (entry.isDirectory()) {
      await walkFiles(fullPath, predicate, out);
    } else if (entry.isFile() && predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

function claudeConfigDirs(home) {
  const multi = nonEmptyString(process.env.CLAUDE_CONFIG_DIRS);
  if (multi) {
    const dirs = multi
      .split(Path.delimiter)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => Path.resolve(expandHome(value, home)));
    if (dirs.length > 0) return [...new Set(dirs)];
  }
  const single = nonEmptyString(process.env.CLAUDE_CONFIG_DIR);
  if (single) return [Path.resolve(expandHome(single, home))];
  return [Path.join(home, ".claude")];
}

function desktopSessionRoots(home) {
  const override = nonEmptyString(process.env.CLAUDE_DESKTOP_SESSIONS_DIR) ||
    nonEmptyString(process.env.CODEBURN_DESKTOP_SESSIONS_DIR);
  if (override) return [Path.resolve(expandHome(override, home))];
  // Keep all platform roots in the candidate set. This matters for portable
  // archives and tests that use a synthetic home while running on another OS.
  return [
    Path.join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions"),
    Path.join(home, ".config", "Claude", "local-agent-mode-sessions"),
    Path.join(home, "AppData", "Roaming", "Claude", "local-agent-mode-sessions"),
  ];
}

function isClaudeDesktopProjectFile(path) {
  if (!path.endsWith(".jsonl")) return false;
  const normalized = path.replace(/\\/g, "/");
  return /\/\.claude\/projects\/[^/]+\//.test(normalized);
}

async function discoverClaudeInputs(home) {
  const paths = [];
  for (const root of claudeConfigDirs(home)) {
    paths.push(...await walkFiles(Path.join(root, "projects"), (path) => path.endsWith(".jsonl")));
  }
  for (const root of desktopSessionRoots(home)) {
    paths.push(...await walkFiles(root, isClaudeDesktopProjectFile));
  }
  return paths.map((path) => ({ kind: "jsonl", adapter: "claude", path }));
}

async function discoverPiInputs(home) {
  const root = Path.join(home, ".pi", "agent", "sessions");
  const paths = await walkFiles(root, (path) => path.endsWith(".jsonl"));
  return paths.map((path) => ({ kind: "jsonl", adapter: "pi", path }));
}

async function discoverGeminiInputs(home) {
  const root = nonEmptyString(process.env.GEMINI_TMP_DIR)
    ? Path.resolve(expandHome(process.env.GEMINI_TMP_DIR, home))
    : Path.join(home, ".gemini", "tmp");
  const paths = [];
  let projects;
  try {
    projects = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const chats = Path.join(root, project.name, "chats");
    let files;
    try { files = await fsp.readdir(chats, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith("session-")) continue;
      if (!file.name.endsWith(".json") && !file.name.endsWith(".jsonl")) continue;
      paths.push({ kind: "jsonl", adapter: "gemini", path: Path.join(chats, file.name) });
    }
  }
  return paths;
}

async function discoverQwenInputs(home) {
  const root = nonEmptyString(process.env.QWEN_DATA_DIR)
    ? Path.resolve(expandHome(process.env.QWEN_DATA_DIR, home))
    : Path.join(home, ".qwen", "projects");
  const paths = [];
  let projects;
  try { projects = await fsp.readdir(root, { withFileTypes: true }); } catch { return []; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const chats = Path.join(root, project.name, "chats");
    let files;
    try { files = await fsp.readdir(chats, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (file.isFile() && file.name.endsWith(".jsonl")) {
        paths.push({ kind: "jsonl", adapter: "qwen", path: Path.join(chats, file.name) });
      }
    }
  }
  return paths;
}

async function dedupeInputs(inputs) {
  const seen = new Set();
  const output = [];
  for (const input of inputs) {
    const resolved = await realPathOrResolve(input.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    output.push({ ...input, path: resolved, realPath: resolved, sourceIdentity: resolved });
  }
  return output;
}

async function discoverHarnessInputs(options = {}) {
  const home = Path.resolve(options.home || os.homedir());
  const source = options.source || "all";
  const inputs = [];
  if (source === "all" || source === "claude") inputs.push(...await discoverClaudeInputs(home));
  if (source === "all" || source === "pi") inputs.push(...await discoverPiInputs(home));
  if (source === "all" || source === "gemini") inputs.push(...await discoverGeminiInputs(home));
  if (source === "all" || source === "qwen") inputs.push(...await discoverQwenInputs(home));
  if (source === "all" || source === "opencode") inputs.push(...await discoverOpenCodeInputs(home));
  if (source === "all" || source === "cursor") inputs.push(...await discoverCursorInputs(home));
  if (source === "all" || source === "grok") inputs.push(...await discoverGrokInputs(home));
  return dedupeInputs(inputs);
}

function adapterForPath(filename, hint = null) {
  if (hint) return hint;
  const normalized = filename.replace(/\\/g, "/");
  if (Path.extname(filename).toLowerCase() === ".db") return "opencode";
  if (Path.extname(filename).toLowerCase() === ".json") return "gemini";
  if (normalized.includes("/.pi/agent/sessions/")) return "pi";
  if (normalized.includes("/.gemini/tmp/") && /\/chats\/session-[^/]+\.jsonl$/.test(normalized)) return "gemini";
  if (normalized.includes("/.qwen/projects/") && /\/chats\/[^/]+\.jsonl$/.test(normalized)) return "qwen";
  if (normalized.includes("/.cursor/projects/") && normalized.includes("/agent-transcripts/")) return "cursor";
  if (Path.basename(filename) === "updates.jsonl" && normalized.includes("/.grok/sessions/")) return "grok";
  return "generic";
}

function fileKind(filename) {
  const extension = Path.extname(filename).toLowerCase();
  if (extension === ".db") return "db";
  if (extension === ".json") return "json";
  return "jsonl";
}

function parseError(report, session, filename, lineNo, error, options) {
  report.sources.parseErrors += 1;
  if (session) session.parseErrors += 1;
  if (options.strictJson) {
    const suffix = lineNo == null ? "" : `:${lineNo}`;
    const reason = error && error.message ? `: ${error.message}` : "";
    throw new Error(`Invalid JSON in ${filename}${suffix}${reason}`);
  }
}

async function processJsonlRecords(filename, report, options, session, callback) {
  const stream = fs.createReadStream(filename, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo += 1;
      session.lines += 1;
      if (!line.trim()) continue;
      let json;
      try {
        json = JSON.parse(line);
      } catch (error) {
        parseError(report, session, filename, lineNo, error, options);
        continue;
      }
      session.records += 1;
      await callback(json, lineNo);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function explicitProvider(...values) {
  for (const value of values) {
    const provider = nonEmptyString(value);
    if (provider) return provider;
  }
  return null;
}

function timestamp(value) {
  return new Date(value);
}

function addHarnessUsage(report, session, options, record) {
  const added = addUsage(report, {
    provider: record.provider,
    model: record.model || UNKNOWN_MODEL,
    project: record.project || UNKNOWN_PROJECT,
    effort: UNKNOWN_EFFORT,
    serviceMode: UNKNOWN_SERVICE_MODE,
    agent: record.agent,
    timestamp: record.timestamp,
    usage: record.usage,
    sourcePath: session?.path || record.sourcePath,
    lineNo: record.lineNo,
  }, options);
  if (session) addToStats(session.stats, added.usage, added.cost);
  return added;
}

function pathProject(filename, segmentsFromEnd = 2) {
  const parts = filename.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= segmentsFromEnd ? parts[parts.length - segmentsFromEnd] : UNKNOWN_PROJECT;
}

async function processPiJsonl(filename, report, options, session) {
  const state = { sessionId: Path.basename(filename, ".jsonl"), project: pathProject(filename, 2), seen: new Set() };
  await processJsonlRecords(filename, report, options, session, async (json, lineNo) => {
    if (json.type === "session") {
      state.sessionId = nonEmptyString(json.id) || state.sessionId;
      state.project = nonEmptyString(json.cwd) || state.project;
      return;
    }
    if (json.type !== "message" || json.message?.role !== "assistant" || !json.message?.usage) return;
    const usage = json.message.usage;
    const input = numeric(usage.input);
    const output = numeric(usage.output);
    const cacheRead = numeric(usage.cacheRead);
    const cacheWrite = numeric(usage.cacheWrite);
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return;
    const key = `${state.sessionId}:${json.message.responseId || json.id || lineNo}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    addHarnessUsage(report, session, options, {
      provider: explicitProvider(json.message.provider, json.message.providerID, json.message.providerId, json.provider) || "pi",
      agent: "pi",
      model: nonEmptyString(json.message.model) || UNKNOWN_MODEL,
      project: state.project,
      timestamp: timestamp(json.timestamp),
      usage: {
        input,
        inputIncludesCacheRead: false,
        cacheCreate5m: cacheWrite,
        cacheRead,
        output,
        reasoningOutput: 0,
      },
      lineNo,
    });
  });
}

function addGeminiMessage(json, state, report, session, options, lineNo) {
  if (!json || json.type !== "gemini" || !json.tokens) return;
  const tokens = json.tokens;
  const input = numeric(tokens.input);
  const cacheRead = numeric(tokens.cached);
  const reasoningOutput = numeric(tokens.thoughts);
  // Gemini reports visible output and thoughts as disjoint buckets. Local
  // sessions satisfy total = input + output + thoughts (+ tool tokens), so the
  // canonical output bucket must include thoughts for complete token and cost
  // accounting while reasoningOutput remains the attributed subset.
  const output = numeric(tokens.output) + reasoningOutput;
  if (input === 0 && cacheRead === 0 && output === 0 && reasoningOutput === 0) return;
  const key = `${state.sessionId}:${json.id || lineNo}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  addHarnessUsage(report, session, options, {
    provider: explicitProvider(json.provider, json.providerID, json.providerId) || "gemini",
    agent: "gemini",
    model: nonEmptyString(json.model) || UNKNOWN_MODEL,
    project: state.project,
    timestamp: timestamp(json.timestamp || state.startTime),
    // Gemini's `input` already includes the cached subset. normalizeUsage
    // subtracts cacheRead exactly once because this flag remains true.
    usage: { input, cacheRead, output, reasoningOutput },
    lineNo,
  });
}

function parseGeminiDocument(document, report, session, options, filename) {
  if (!document || typeof document !== "object" || !Array.isArray(document.messages) || !nonEmptyString(document.sessionId)) {
    parseError(report, session, filename, null, new Error("missing Gemini session shape"), options);
    return;
  }
  const state = {
    sessionId: document.sessionId,
    startTime: document.startTime,
    project: pathProject(filename, 3),
    seen: new Set(),
  };
  for (const [index, message] of document.messages.entries()) {
    session.records += 1;
    addGeminiMessage(message, state, report, session, options, index + 1);
  }
}

async function processGeminiJsonOrJsonl(filename, report, options, session) {
  if (Path.extname(filename).toLowerCase() === ".json") {
    let document;
    try {
      document = JSON.parse(await fsp.readFile(filename, "utf8"));
      session.lines = 1;
    } catch (error) {
      parseError(report, session, filename, null, error, options);
      return;
    }
    parseGeminiDocument(document, report, session, options, filename);
    return;
  }

  const state = {
    sessionId: Path.basename(filename, ".jsonl"),
    startTime: null,
    project: pathProject(filename, 3),
    seen: new Set(),
  };
  await processJsonlRecords(filename, report, options, session, async (json, lineNo) => {
    if (nonEmptyString(json.sessionId)) {
      state.sessionId = json.sessionId;
      state.startTime = json.startTime || state.startTime;
      if (json.project) state.project = json.project;
      return;
    }
    addGeminiMessage(json, state, report, session, options, lineNo);
  });
}

async function processQwenJsonl(filename, report, options, session) {
  const state = { project: pathProject(filename, 3), seen: new Set() };
  await processJsonlRecords(filename, report, options, session, async (json, lineNo) => {
    if (json.cwd) state.project = json.cwd;
    if (json.type !== "assistant" || !json.usageMetadata) return;
    const usage = json.usageMetadata;
    const input = numeric(usage.promptTokenCount);
    const cacheRead = numeric(usage.cachedContentTokenCount);
    const reasoningOutput = numeric(usage.thoughtsTokenCount);
    // Qwen's Gemini-compatible UsageMetadata reports candidates and thoughts
    // separately; both are output-billed tokens.
    const output = numeric(usage.candidatesTokenCount) + reasoningOutput;
    if (input === 0 && cacheRead === 0 && output === 0 && reasoningOutput === 0) return;
    const key = `${json.sessionId || Path.basename(filename)}:${json.uuid || lineNo}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    addHarnessUsage(report, session, options, {
      provider: explicitProvider(json.provider, json.providerID, json.providerId) || "qwen",
      agent: "qwen",
      model: nonEmptyString(json.model) || nonEmptyString(json.message?.model) || UNKNOWN_MODEL,
      project: state.project,
      timestamp: timestamp(json.timestamp),
      // Qwen's cachedContentTokenCount is a subset of promptTokenCount.
      usage: { input, cacheRead, output, reasoningOutput },
      lineNo,
    });
  });
}

async function processHarnessFile(filename, report, options, session, hint = null) {
  const adapter = adapterForPath(filename, hint);
  if (adapter === "cursor" || adapter === "grok") {
    await processObservedHarnessFile(filename, report, options, session, adapter);
  } else if (adapter === "pi") {
    await processPiJsonl(filename, report, options, session);
  } else if (adapter === "gemini") {
    await processGeminiJsonOrJsonl(filename, report, options, session);
  } else if (adapter === "qwen") {
    await processQwenJsonl(filename, report, options, session);
  } else if (adapter === "opencode") {
    processOpenCodeDb(filename, report, options, session);
  }
}

module.exports = {
  adapterForPath,
  claudeConfigDirs,
  discoverCursorInputs,
  desktopSessionRoots,
  discoverClaudeInputs,
  discoverGeminiInputs,
  discoverHarnessInputs,
  discoverGrokInputs,
  discoverPiInputs,
  discoverQwenInputs,
  fileKind,
  processHarnessFile,
};
