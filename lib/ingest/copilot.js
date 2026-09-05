"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Path = require("node:path");
const readline = require("node:readline");
const { fileURLToPath } = require("node:url");
const {
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
} = require("../core/report-model");
const {
  observationBase,
  observedSourceError,
} = require("./observed-harnesses");

const MULTIPLE_MODELS = "(multiple models)";
const COPILOT_VSCODE_FIELDS = new Set([
  "completionTokens",
  "copilotCredits",
  "elapsedMs",
  "modelId",
  "promptTokens",
  "requestId",
  "responseId",
  "responseTimestamp",
  "timestamp",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function latestTimestamp(current, candidate) {
  const parsed = isoTimestamp(candidate);
  if (!parsed) return current;
  if (!current || Date.parse(parsed) > Date.parse(current)) return parsed;
  return current;
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

function copilotCliRoot(home) {
  return Path.join(home, ".copilot", "session-state");
}

function copilotVscodeRoots(home) {
  return [
    Path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"),
    Path.join(home, ".config", "Code", "User", "workspaceStorage"),
    Path.join(home, "AppData", "Roaming", "Code", "User", "workspaceStorage"),
  ];
}

async function firstJsonRecord(filename) {
  const stream = fs.createReadStream(filename, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      return JSON.parse(line);
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

function isCopilotVscodeSnapshot(record) {
  if (!record || record.kind !== 0 || !record.v || typeof record.v !== "object") return false;
  const snapshot = record.v;
  if (nonEmptyString(snapshot.responderUsername)?.toLowerCase() === "github copilot") return true;
  const selectedModel = nonEmptyString(snapshot.inputState?.selectedModel?.identifier);
  if (selectedModel?.toLowerCase().startsWith("copilot/")) return true;
  const extension = nonEmptyString(snapshot.inputState?.selectedModel?.metadata?.extension?._lower) ||
    nonEmptyString(snapshot.inputState?.selectedModel?.metadata?.extension?.value);
  if (extension?.toLowerCase() === "github.copilot-chat") return true;
  return Array.isArray(snapshot.requests) && snapshot.requests.some((request) =>
    nonEmptyString(request?.modelId)?.toLowerCase().startsWith("copilot/"));
}

async function discoverCopilotCliInputs(home) {
  const paths = await walkFiles(copilotCliRoot(home), (filename) => Path.basename(filename) === "events.jsonl");
  return paths.map((path) => ({ kind: "jsonl", adapter: "copilot-cli", path }));
}

async function discoverCopilotVscodeInputs(home) {
  const output = [];
  for (const root of copilotVscodeRoots(home)) {
    let workspaces;
    try {
      workspaces = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const workspace of workspaces) {
      if (!workspace.isDirectory()) continue;
      const chatSessions = Path.join(root, workspace.name, "chatSessions");
      let files;
      try {
        files = await fsp.readdir(chatSessions, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
        const sessionPath = Path.join(chatSessions, file.name);
        if (isCopilotVscodeSnapshot(await firstJsonRecord(sessionPath))) {
          output.push({ kind: "jsonl", adapter: "copilot-vscode", path: sessionPath });
        }
      }
    }
  }
  return output;
}

async function discoverCopilotInputs(home) {
  return [
    ...await discoverCopilotCliInputs(home),
    ...await discoverCopilotVscodeInputs(home),
  ];
}

function adapterForCopilotPath(filename, hint = null) {
  if (hint === "copilot-cli" || hint === "copilot-vscode") return hint;
  const normalized = filename.replace(/\\/g, "/");
  if (Path.basename(filename) === "events.jsonl" && normalized.includes("/.copilot/session-state/")) {
    return "copilot-cli";
  }
  if (normalized.includes("/Code/User/workspaceStorage/") && normalized.includes("/chatSessions/") && filename.endsWith(".jsonl")) {
    return "copilot-vscode";
  }
  return null;
}

async function processJsonlRecords(filename, report, options, session, callback) {
  const stream = fs.createReadStream(filename, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const line of lines) {
      lineNo += 1;
      session.lines += 1;
      if (line.trim() === "") continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (error) {
        observedSourceError(report, session, `${filename}:${lineNo}`, error, options);
        continue;
      }
      session.records += 1;
      try {
        callback(record, lineNo);
      } catch (error) {
        observedSourceError(report, session, `${filename}:${lineNo}`, error, options);
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function modelSummary(models) {
  const values = [...models].filter(Boolean).sort();
  if (values.length === 0) return UNKNOWN_MODEL;
  if (values.length === 1) return values[0];
  return MULTIPLE_MODELS;
}

function normalizedCopilotModel(value) {
  const model = nonEmptyString(value);
  if (!model) return null;
  return model.toLowerCase().startsWith("copilot/") ? model.slice("copilot/".length) : model;
}

async function processCopilotCli(filename, report, options, session) {
  const state = {
    completedTurns: new Set(),
    copilotVersion: null,
    models: new Set(),
    outputTokens: 0,
    outputTokensSeen: false,
    producer: null,
    project: UNKNOWN_PROJECT,
    sessionId: Path.basename(Path.dirname(filename)),
    sourceTimestamp: null,
    startSeen: false,
    totalNanoAiu: null,
    totalPremiumRequests: null,
  };

  await processJsonlRecords(filename, report, options, session, (record, lineNo) => {
    state.sourceTimestamp = latestTimestamp(state.sourceTimestamp, record.timestamp);
    const data = record.data && typeof record.data === "object" ? record.data : {};
    if (record.type === "session.start") {
      state.startSeen = true;
      state.sessionId = nonEmptyString(data.sessionId) || state.sessionId;
      state.producer = nonEmptyString(data.producer);
      state.copilotVersion = nonEmptyString(data.copilotVersion);
      state.project = nonEmptyString(data.context?.cwd) || state.project;
      state.sourceTimestamp = latestTimestamp(state.sourceTimestamp, data.startTime);
    } else if (record.type === "session.model_change") {
      const model = normalizedCopilotModel(data.newModel);
      if (model) state.models.add(model);
    } else if (record.type === "assistant.message") {
      const model = normalizedCopilotModel(data.model);
      if (model) state.models.add(model);
      const outputTokens = nonNegativeNumber(data.outputTokens);
      if (outputTokens !== null) {
        state.outputTokens += outputTokens;
        state.outputTokensSeen = true;
      }
      const turnId = nonEmptyString(data.turnId);
      if (turnId) state.completedTurns.add(turnId);
    } else if (record.type === "assistant.turn_end") {
      state.completedTurns.add(nonEmptyString(data.turnId) || `line:${lineNo}`);
    } else if (record.type === "session.usage_checkpoint") {
      state.totalNanoAiu = nonNegativeNumber(data.totalNanoAiu);
      state.totalPremiumRequests = nonNegativeNumber(data.totalPremiumRequests);
    }
  });

  if (!state.startSeen || state.producer !== "copilot-agent") {
    observedSourceError(report, session, filename, new Error("missing Copilot CLI session.start shape"), options);
    return;
  }

  const observation = observationBase({
    agent: "copilot-cli",
    provider: "github",
    model: modelSummary(state.models),
    project: state.project,
    sourceTimestamp: state.sourceTimestamp,
    sourceTimestampProvenance: state.sourceTimestamp ? "event.timestamp" : "event.timestamp-unavailable",
  });
  observation.sessionId = state.sessionId;
  observation.requestCount = state.completedTurns.size;
  if (state.outputTokensSeen) observation.reportedOutputTokens = state.outputTokens;
  observation.counterProvenance = "assistant.message.outputTokens + session.usage_checkpoint";
  if (state.copilotVersion) observation.copilotVersion = state.copilotVersion;
  if (state.totalPremiumRequests !== null) observation.premiumRequests = state.totalPremiumRequests;
  if (state.totalNanoAiu !== null) {
    observation.reportedNanoAiu = state.totalNanoAiu;
    observation.aiUnits = state.totalNanoAiu / 1e9;
  }
  session.stats.observation = observation;
}

function sanitizeResultMetadata(result) {
  const metadata = result?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return {
    outputTokens: nonNegativeNumber(metadata.outputTokens),
    promptTokens: nonNegativeNumber(metadata.promptTokens),
    resolvedModel: normalizedCopilotModel(metadata.resolvedModel),
    toolCallRounds: Array.isArray(metadata.toolCallRounds) ? metadata.toolCallRounds.length : null,
  };
}

function sanitizeVscodeRequest(request) {
  if (!request || typeof request !== "object") return {};
  const output = {};
  for (const field of COPILOT_VSCODE_FIELDS) {
    if (Object.hasOwn(request, field)) output[field] = request[field];
  }
  output.resultMetadata = sanitizeResultMetadata(request.result);
  return output;
}

function snapshotMetadata(snapshot) {
  return {
    creationDate: snapshot.creationDate,
    responderUsername: snapshot.responderUsername,
    selectedModel: snapshot.inputState?.selectedModel?.identifier,
    selectedModelExtension: snapshot.inputState?.selectedModel?.metadata?.extension?._lower ||
      snapshot.inputState?.selectedModel?.metadata?.extension?.value,
    sessionId: snapshot.sessionId,
    version: snapshot.version,
    requests: Array.isArray(snapshot.requests) ? snapshot.requests.map(sanitizeVscodeRequest) : [],
  };
}

function applyVscodeJournalRecord(state, record) {
  if (record.kind === 0) {
    if (!record.v || typeof record.v !== "object") throw new Error("invalid VS Code snapshot");
    return snapshotMetadata(record.v);
  }
  if (!state || !Array.isArray(record.k)) throw new Error("VS Code journal record precedes snapshot");
  const [root, index, field] = record.k;
  if (record.kind === 2) {
    if (root === "requests" && record.k.length === 1) {
      if (!Array.isArray(record.v)) throw new Error("VS Code request splice must contain an array");
      const at = record.i == null ? state.requests.length : record.i;
      if (!Number.isInteger(at) || at < 0 || at > state.requests.length) throw new Error("invalid VS Code request splice index");
      state.requests.splice(at, 0, ...record.v.map(sanitizeVscodeRequest));
    }
    // Response-array splices carry conversation/tool content, not usage
    // metadata, and are intentionally ignored.
    return state;
  }
  if (record.kind !== 1) throw new Error(`unsupported VS Code journal kind ${record.kind}`);
  if (root !== "requests") return state;
  if (!Number.isInteger(index) || index < 0 || index >= state.requests.length) throw new Error("invalid VS Code request index");
  if (record.k.length === 2) {
    state.requests[index] = sanitizeVscodeRequest(record.v);
  } else if (field === "result") {
    state.requests[index].resultMetadata = sanitizeResultMetadata(record.v);
  } else if (COPILOT_VSCODE_FIELDS.has(field)) {
    state.requests[index][field] = record.v;
  }
  return state;
}

function isCopilotVscodeState(state) {
  if (!state) return false;
  if (nonEmptyString(state.responderUsername)?.toLowerCase() === "github copilot") return true;
  if (nonEmptyString(state.selectedModel)?.toLowerCase().startsWith("copilot/")) return true;
  if (nonEmptyString(state.selectedModelExtension)?.toLowerCase() === "github.copilot-chat") return true;
  return state.requests.some((request) => nonEmptyString(request.modelId)?.toLowerCase().startsWith("copilot/"));
}

async function vscodeWorkspaceProject(filename) {
  const workspaceFile = Path.join(Path.dirname(Path.dirname(filename)), "workspace.json");
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(workspaceFile, "utf8"));
  } catch {
    return UNKNOWN_PROJECT;
  }
  const value = nonEmptyString(metadata.folder) || nonEmptyString(metadata.workspace);
  if (!value) return UNKNOWN_PROJECT;
  if (!value.startsWith("file:")) return value;
  try {
    const decoded = fileURLToPath(value);
    return metadata.workspace ? Path.dirname(decoded) : decoded;
  } catch {
    return UNKNOWN_PROJECT;
  }
}

async function processCopilotVscode(filename, report, options, session) {
  let state = null;
  await processJsonlRecords(filename, report, options, session, (record) => {
    state = applyVscodeJournalRecord(state, record);
  });
  if (!isCopilotVscodeState(state)) {
    observedSourceError(report, session, filename, new Error("missing GitHub Copilot VS Code session shape"), options);
    return;
  }

  const models = new Set();
  const selectedModel = normalizedCopilotModel(state.selectedModel);
  if (selectedModel) models.add(selectedModel);
  let sourceTimestamp = latestTimestamp(null, state.creationDate);
  let sourceTimestampProvenance = sourceTimestamp ? "journal.creationDate" : "journal.timestamp-unavailable";
  let reportedPromptTokens = 0;
  let reportedCompletionTokens = 0;
  let reportedCopilotCredits = 0;
  let toolCallRounds = 0;
  let promptTokensSeen = false;
  let completionTokensSeen = false;
  let copilotCreditsSeen = false;
  let toolCallRoundsSeen = false;
  for (const request of state.requests) {
    const model = request.resultMetadata?.resolvedModel || normalizedCopilotModel(request.modelId);
    if (model) models.add(model);
    const requestTimestamp = isoTimestamp(request.timestamp);
    if (requestTimestamp && (!sourceTimestamp || Date.parse(requestTimestamp) >= Date.parse(sourceTimestamp))) {
      sourceTimestamp = requestTimestamp;
      sourceTimestampProvenance = "journal.request.timestamp";
    }
    const responseTimestamp = isoTimestamp(request.responseTimestamp);
    if (responseTimestamp && (!sourceTimestamp || Date.parse(responseTimestamp) >= Date.parse(sourceTimestamp))) {
      sourceTimestamp = responseTimestamp;
      sourceTimestampProvenance = "journal.request.responseTimestamp";
    }
    const promptTokens = nonNegativeNumber(request.promptTokens);
    if (promptTokens !== null) {
      reportedPromptTokens += promptTokens;
      promptTokensSeen = true;
    }
    const completionTokens = nonNegativeNumber(request.completionTokens);
    if (completionTokens !== null) {
      reportedCompletionTokens += completionTokens;
      completionTokensSeen = true;
    }
    const copilotCredits = nonNegativeNumber(request.copilotCredits);
    if (copilotCredits !== null) {
      reportedCopilotCredits += copilotCredits;
      copilotCreditsSeen = true;
    }
    const requestToolCallRounds = nonNegativeNumber(request.resultMetadata?.toolCallRounds);
    if (requestToolCallRounds !== null) {
      toolCallRounds += requestToolCallRounds;
      toolCallRoundsSeen = true;
    }
  }

  const observation = observationBase({
    agent: "copilot-vscode",
    provider: "github",
    model: modelSummary(models),
    project: await vscodeWorkspaceProject(filename),
    sourceTimestamp,
    sourceTimestampProvenance,
  });
  observation.sessionId = nonEmptyString(state.sessionId) || Path.basename(filename, ".jsonl");
  observation.requestCount = state.requests.length;
  if (promptTokensSeen) observation.reportedPromptTokens = reportedPromptTokens;
  if (completionTokensSeen) observation.reportedCompletionTokens = reportedCompletionTokens;
  if (copilotCreditsSeen) observation.reportedCopilotCredits = Number(reportedCopilotCredits.toFixed(9));
  if (toolCallRoundsSeen) observation.reportedToolCallRounds = toolCallRounds;
  observation.counterProvenance = "chatSessions journal final request fields";
  if (nonNegativeNumber(state.version) !== null) observation.formatVersion = Number(state.version);
  session.stats.observation = observation;
}

async function processCopilotFile(filename, report, options, session, hint = null) {
  const adapter = adapterForCopilotPath(filename, hint);
  if (adapter === "copilot-cli") return processCopilotCli(filename, report, options, session);
  if (adapter === "copilot-vscode") return processCopilotVscode(filename, report, options, session);
  return false;
}

module.exports = {
  adapterForCopilotPath,
  copilotCliRoot,
  copilotVscodeRoots,
  discoverCopilotCliInputs,
  discoverCopilotInputs,
  discoverCopilotVscodeInputs,
  isCopilotVscodeSnapshot,
  processCopilotFile,
};
