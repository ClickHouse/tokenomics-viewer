"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const {
  buildReport,
  buildReportFromDatabase,
  syncDatabase,
} = require("../app");
const { webSummary } = require("../lib/dashboard");
const { defaultOptions } = require("./support/fixtures");

function tempHome() {
  return fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-observed-harnesses-"));
}

function writeJson(path, value) {
  fs.mkdirSync(Path.dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(value) + "\n");
}

function observedFixture(home) {
  const cursorTranscript = Path.join(
    home,
    ".cursor",
    "projects",
    "tokenomics-project",
    "agent-transcripts",
    "cursor-session.jsonl",
  );
  fs.mkdirSync(Path.dirname(cursorTranscript), { recursive: true });
  // The parser must not use transcript content for observed-only ingestion.
  fs.writeFileSync(cursorTranscript, "not-json transcript content\n");
  const cursorAt = new Date("2026-07-20T01:02:03.000Z");
  fs.utimesSync(cursorTranscript, cursorAt, cursorAt);

  const grokDir = Path.join(
    home,
    ".grok",
    "sessions",
    "%2Ftmp%2Fgrok-project",
    "grok-session",
  );
  writeJson(Path.join(grokDir, "summary.json"), {
    info: { id: "grok-session", cwd: "/tmp/grok-project" },
    created_at: "2026-07-21T01:02:03.000Z",
    updated_at: "2026-07-21T01:04:05.000Z",
    current_model_id: "grok-4.20-0309-non-reasoning",
  });
  writeJson(Path.join(grokDir, "signals.json"), {
    contextTokensUsed: 65432,
    contextWindowTokens: 128000,
  });
  // The updates stream is deliberately invalid: observed ingestion reads only
  // summary/signals metadata and must not parse conversation/tool content.
  fs.writeFileSync(Path.join(grokDir, "updates.jsonl"), "not-json updates content\n");

  return { cursorTranscript, grokUpdates: Path.join(grokDir, "updates.jsonl") };
}

test("Cursor Agent and Grok Build are observed-only and excluded from exact totals", async () => {
  const home = tempHome();
  const paths = observedFixture(home);
  const report = await buildReport(defaultOptions({ home, source: "all", progress: false }));

  assert.equal(report.total.requests, 0);
  assert.equal(report.total.input, 0);
  assert.equal(report.total.output, 0);
  assert.equal(report.total.costUsd, 0);
  assert.deepEqual(report.agents, {});
  assert.deepEqual(report.serviceModes, {});
  assert.equal(report.sessions.length, 2);

  const cursor = report.sessions.find((session) => session.path === fs.realpathSync(paths.cursorTranscript));
  assert.ok(cursor);
  assert.deepEqual(cursor.stats.observation, {
    agent: "cursor-agent",
    provider: "cursor",
    model: "(unknown model)",
    project: "tokenomics-project",
    measurement: "observed-only",
    exactUsageAvailable: false,
    sourceTimestamp: "2026-07-20T01:02:03.000Z",
    sourceTimestampProvenance: "fileModifiedAt",
  });

  const grok = report.sessions.find((session) => session.path === fs.realpathSync(paths.grokUpdates));
  assert.ok(grok);
  assert.deepEqual(grok.stats.observation, {
    agent: "grok-build",
    provider: "grok",
    model: "grok-4.20-0309-non-reasoning",
    project: "/tmp/grok-project",
    measurement: "observed-only",
    exactUsageAvailable: false,
    sourceTimestamp: "2026-07-21T01:04:05.000Z",
    sourceTimestampProvenance: "summary.updated_at",
    contextTokens: 65432,
    contextWindowTokens: 128000,
  });
  assert.equal(grok.lines, 0);
  assert.equal(grok.records, 0);
});

test("observed metadata survives SQLite stats_json persistence", async () => {
  const home = tempHome();
  observedFixture(home);
  const db = Path.join(home, "tokenomics.sqlite");
  const options = defaultOptions({ home, source: "all", db, progress: false });
  const synced = await syncDatabase(options);
  const reloaded = buildReportFromDatabase(db, options);
  assert.equal(synced.total.requests, 0);
  assert.equal(reloaded.total.requests, 0);
  assert.equal(reloaded.sessions.length, 2);
  assert.equal(reloaded.sessions.every((session) => session.stats.observation?.measurement === "observed-only"), true);
  assert.equal(reloaded.sessions.find((session) => session.stats.observation?.agent === "grok-build").stats.observation.contextTokens, 65432);
});

test("dashboard exposes observed harness coverage without usage totals", async () => {
  const home = tempHome();
  observedFixture(home);
  const report = await buildReport(defaultOptions({ home, source: "all", progress: false }));
  const summary = webSummary(report, defaultOptions({ now: new Date("2026-07-22T00:00:00.000Z") }));
  assert.equal(summary.total.requests, 0);
  assert.equal(summary.observedHarnesses.length, 2);
  assert.deepEqual(summary.observedHarnesses.map((row) => row.agent).sort(), ["cursor-agent", "grok-build"]);
  assert.equal(summary.observedHarnesses.every((row) => row.measurement === "observed-only" && row.exactUsageAvailable === false), true);
  assert.match(require("../lib/dashboard").dashboardHtml(), /Observed Harness Coverage/);
  assert.match(require("../lib/dashboard").dashboardHtml(), /usage unavailable/i);
});

test("malformed observed metadata is isolated in lenient mode and strict mode throws", async () => {
  const home = tempHome();
  const badDir = Path.join(home, ".grok", "sessions", "%2Ftmp%2Fbad", "bad-session");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(Path.join(badDir, "summary.json"), "{not-json\n");
  fs.writeFileSync(Path.join(badDir, "updates.jsonl"), "unused\n");
  const good = Path.join(home, ".cursor", "projects", "good", "agent-transcripts", "session.jsonl");
  fs.mkdirSync(Path.dirname(good), { recursive: true });
  fs.writeFileSync(good, "unused\n");

  const lenient = await buildReport(defaultOptions({ home, source: "all", progress: false }));
  assert.equal(lenient.total.requests, 0);
  assert.ok(lenient.sources.parseErrors >= 1);
  assert.ok(lenient.sessions.some((session) => session.path.endsWith("bad-session/updates.jsonl") && session.parseErrors >= 1));
  await assert.rejects(
    () => buildReport(defaultOptions({ home, source: "all", strictJson: true, progress: false })),
    /Invalid JSON|Malformed JSON|Unexpected token/,
  );
});

test("observed model names containing fast do not create service modes", async () => {
  const home = tempHome();
  const grokDir = Path.join(home, ".grok", "sessions", "%2Ftmp%2Ffast-project", "fast-session");
  writeJson(Path.join(grokDir, "summary.json"), {
    info: { id: "fast-session", cwd: "/tmp/fast-project" },
    updated_at: "2026-07-21T01:04:05.000Z",
    current_model_id: "grok-fast",
  });
  fs.writeFileSync(Path.join(grokDir, "updates.jsonl"), "unused\n");
  const report = await buildReport(defaultOptions({ home, source: "grok", progress: false }));
  assert.equal(report.total.requests, 0);
  assert.deepEqual(report.serviceModes, {});
  assert.equal(report.sessions[0].stats.observation.model, "grok-fast");
});
