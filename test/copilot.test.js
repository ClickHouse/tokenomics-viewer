"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const {
  buildReport,
  buildReportFromDatabase,
  discoverInputs,
  syncDatabase,
} = require("../app");
const { webSummary } = require("../lib/dashboard");
const { adapterForPath } = require("../lib/ingest/harnesses");
const { defaultOptions } = require("./support/fixtures");

function tempHome() {
  return fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-copilot-"));
}

function writeJsonl(filename, rows) {
  fs.mkdirSync(Path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n");
}

function copilotFixture(home) {
  const cli = Path.join(home, ".copilot", "session-state", "cli-session", "events.jsonl");
  writeJsonl(cli, [
    {
      id: "start",
      type: "session.start",
      timestamp: "2026-08-01T00:00:00.000Z",
      data: {
        sessionId: "cli-session",
        producer: "copilot-agent",
        copilotVersion: "1.0.78",
        startTime: "2026-08-01T00:00:00.000Z",
        context: { cwd: "/tmp/copilot-cli-project" },
      },
    },
    {
      id: "message",
      type: "assistant.message",
      timestamp: "2026-08-01T00:00:01.000Z",
      data: { model: "claude-opus-5", outputTokens: 7, turnId: "turn-1", content: "cli-private-content-marker" },
    },
    {
      id: "turn-end",
      type: "assistant.turn_end",
      timestamp: "2026-08-01T00:00:02.000Z",
      data: { turnId: "turn-1" },
    },
    {
      id: "checkpoint",
      type: "session.usage_checkpoint",
      timestamp: "2026-08-01T00:00:03.000Z",
      data: { totalNanoAiu: 3_000_000_000, totalPremiumRequests: 2 },
    },
  ]);

  const workspaceRoot = Path.join(
    home,
    "Library",
    "Application Support",
    "Code",
    "User",
    "workspaceStorage",
    "workspace-hash",
  );
  const vscode = Path.join(workspaceRoot, "chatSessions", "vscode-session.jsonl");
  writeJsonl(vscode, [
    {
      kind: 0,
      v: {
        creationDate: Date.parse("2026-08-02T00:00:00.000Z"),
        sessionId: "vscode-session",
        version: 3,
        responderUsername: "GitHub Copilot",
        inputState: {
          selectedModel: {
            identifier: "copilot/claude-opus-5",
            metadata: { extension: { _lower: "github.copilot-chat" } },
          },
        },
        requests: [{
          requestId: "request-1",
          modelId: "copilot/claude-opus-5",
          promptTokens: 10,
          completionTokens: 2,
          copilotCredits: 1,
          timestamp: Date.parse("2026-08-02T00:00:01.000Z"),
          responseTimestamp: Date.parse("2026-08-02T00:00:02.000Z"),
        }],
      },
    },
    { kind: 1, k: ["requests", 0, "promptTokens"], v: 12 },
    { kind: 1, k: ["requests", 0, "completionTokens"], v: 4 },
    { kind: 1, k: ["requests", 0, "copilotCredits"], v: 1.5 },
    {
      kind: 1,
      k: ["requests", 0, "result"],
      v: {
        metadata: {
          promptTokens: 12,
          outputTokens: 3,
          resolvedModel: "claude-opus-5",
          toolCallRounds: [{}, {}],
        },
      },
    },
    {
      kind: 2,
      k: ["requests"],
      i: null,
      v: [{
        requestId: "request-2",
        modelId: "copilot/claude-opus-5",
        promptTokens: 20,
        completionTokens: 5,
        copilotCredits: 2,
        timestamp: Date.parse("2026-08-02T00:01:00.000Z"),
        responseTimestamp: Date.parse("2026-08-02T00:01:01.000Z"),
        result: {
          metadata: {
            promptTokens: 20,
            outputTokens: 4,
            resolvedModel: "claude-opus-5",
            toolCallRounds: [{}],
          },
        },
      }],
    },
    {
      kind: 2,
      k: ["requests", 1, "response"],
      i: null,
      v: [{ value: "vscode-private-content-marker" }],
    },
  ]);
  fs.writeFileSync(Path.join(workspaceRoot, "workspace.json"), JSON.stringify({ folder: "file:///tmp/copilot-vscode-project" }));

  const unrelated = Path.join(
    home,
    "Library",
    "Application Support",
    "Code",
    "User",
    "workspaceStorage",
    "other-workspace",
    "chatSessions",
    "other.jsonl",
  );
  writeJsonl(unrelated, [{ kind: 0, v: { responderUsername: "Another Extension", requests: [] } }]);

  return { cli, unrelated, vscode };
}

test("discovers Copilot CLI and VS Code sessions while filtering unrelated VS Code chats", async () => {
  const home = tempHome();
  const paths = copilotFixture(home);
  const inputs = await discoverInputs(defaultOptions({ home, source: "all" }));
  assert.deepEqual(inputs.map((input) => input.path).sort(), [fs.realpathSync(paths.cli), fs.realpathSync(paths.vscode)].sort());
  assert.deepEqual(inputs.map((input) => input.adapter).sort(), ["copilot-cli", "copilot-vscode"]);
  assert.equal(adapterForPath(paths.cli), "copilot-cli");
  assert.equal(adapterForPath(paths.vscode), "copilot-vscode");
});

test("Copilot CLI and VS Code counters remain observed-only and do not change exact totals", async () => {
  const home = tempHome();
  const paths = copilotFixture(home);
  const report = await buildReport(defaultOptions({ home, source: "copilot", progress: false }));

  assert.equal(report.sessions.length, 2);
  assert.equal(report.total.requests, 0);
  assert.equal(report.total.input, 0);
  assert.equal(report.total.output, 0);
  assert.equal(report.total.costUsd, 0);
  assert.deepEqual(report.agents, {});
  assert.deepEqual(report.serviceModes, {});
  assert.doesNotMatch(JSON.stringify(report), /(?:cli|vscode)-private-content-marker/);

  const cli = report.sessions.find((session) => session.path === fs.realpathSync(paths.cli));
  assert.deepEqual(cli.stats.observation, {
    agent: "copilot-cli",
    provider: "github",
    model: "claude-opus-5",
    project: "/tmp/copilot-cli-project",
    measurement: "observed-only",
    exactUsageAvailable: false,
    sourceTimestamp: "2026-08-01T00:00:03.000Z",
    sourceTimestampProvenance: "event.timestamp",
    sessionId: "cli-session",
    requestCount: 1,
    reportedOutputTokens: 7,
    counterProvenance: "assistant.message.outputTokens + session.usage_checkpoint",
    copilotVersion: "1.0.78",
    premiumRequests: 2,
    reportedNanoAiu: 3_000_000_000,
    aiUnits: 3,
  });

  const vscode = report.sessions.find((session) => session.path === fs.realpathSync(paths.vscode));
  assert.deepEqual(vscode.stats.observation, {
    agent: "copilot-vscode",
    provider: "github",
    model: "claude-opus-5",
    project: "/tmp/copilot-vscode-project",
    measurement: "observed-only",
    exactUsageAvailable: false,
    sourceTimestamp: "2026-08-02T00:01:01.000Z",
    sourceTimestampProvenance: "journal.request.responseTimestamp",
    sessionId: "vscode-session",
    requestCount: 2,
    reportedPromptTokens: 32,
    reportedCompletionTokens: 9,
    reportedCopilotCredits: 3.5,
    reportedToolCallRounds: 3,
    counterProvenance: "chatSessions journal final request fields",
    formatVersion: 3,
  });

  const summary = webSummary(report, defaultOptions({ now: new Date("2026-08-03T00:00:00.000Z") }));
  assert.deepEqual(summary.observedHarnesses.map((row) => row.agent).sort(), ["copilot-cli", "copilot-vscode"]);
  assert.equal(summary.observedHarnesses.find((row) => row.agent === "copilot-cli").premiumRequests, 2);
  assert.equal(summary.observedHarnesses.find((row) => row.agent === "copilot-cli").aiUnits, 3);
  assert.equal(summary.observedHarnesses.find((row) => row.agent === "copilot-vscode").reportedCopilotCredits, 3.5);
});

test("malformed Copilot journal records are isolated in lenient mode and throw in strict mode", async () => {
  const home = tempHome();
  const paths = copilotFixture(home);
  fs.appendFileSync(paths.vscode, `${JSON.stringify({ kind: 9, k: [] })}\n`);
  fs.appendFileSync(paths.cli, "{not-json\n");

  const lenient = await buildReport(defaultOptions({ home, source: "copilot", progress: false }));
  assert.equal(lenient.total.requests, 0);
  assert.equal(lenient.sessions.length, 2);
  assert.equal(lenient.sources.parseErrors, 2);
  assert.equal(lenient.sessions.every((session) => session.parseErrors === 1), true);
  assert.equal(lenient.sessions.every((session) => session.stats.observation?.measurement === "observed-only"), true);

  await assert.rejects(
    () => buildReport(defaultOptions({ home, source: "copilot", strictJson: true, progress: false })),
    /Invalid JSON/,
  );
});

test("Copilot observations survive SQLite sync and report reload", async () => {
  const home = tempHome();
  copilotFixture(home);
  const db = Path.join(home, "tokenomics.sqlite");
  const options = defaultOptions({ home, source: "copilot", db, progress: false });
  const synced = await syncDatabase(options);
  const reloaded = buildReportFromDatabase(db, options);

  assert.equal(synced.sessions.length, 2);
  assert.equal(reloaded.sessions.length, 2);
  assert.equal(reloaded.total.requests, 0);
  assert.deepEqual(reloaded.sessions.map((session) => session.stats.observation?.agent).sort(), ["copilot-cli", "copilot-vscode"]);
  assert.equal(reloaded.sessions.find((session) => session.stats.observation?.agent === "copilot-cli").stats.observation.premiumRequests, 2);
  assert.equal(reloaded.sessions.find((session) => session.stats.observation?.agent === "copilot-vscode").stats.observation.requestCount, 2);
});
