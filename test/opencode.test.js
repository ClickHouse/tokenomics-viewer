"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");

const { newReport, newStats } = require("../lib/core/report-model");
const {
  discoverOpenCodeInputs,
  isOpenCodeDbPath,
  processOpenCodeDb,
} = require("../lib/ingest/opencode");

function tempHome() {
  return fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-opencode-"));
}

function sessionFor(file) {
  return {
    kind: "db",
    path: file,
    lines: 0,
    records: 0,
    parseErrors: 0,
    stats: newStats(),
  };
}

function options(extra = {}) {
  return {
    strictJson: false,
    openaiContext: "short",
    ...extra,
  };
}

function createDb(file, setup) {
  fs.mkdirSync(Path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER,
      data TEXT NOT NULL
    );
  `);
  setup(db);
  db.close();
}

function addSession(db, id, parentId, directory, archived = null) {
  db.prepare(
    "INSERT INTO session(id, parent_id, directory, title, time_created, time_archived) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, parentId, directory, id, 1_700_000_000_000, archived);
}

test("discovers opencode*.db under the default data root and recognizes explicit DB paths", async () => {
  const home = tempHome();
  const root = Path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(Path.join(root, "opencode.db"), "");
  fs.writeFileSync(Path.join(root, "opencode-work.db"), "");
  fs.writeFileSync(Path.join(root, "other.db"), "");
  fs.writeFileSync(Path.join(root, "opencode.db-wal"), "");

  const inputs = await discoverOpenCodeInputs(home);
  assert.deepEqual(inputs.map((input) => input.path), [
    Path.join(root, "opencode-work.db"),
    Path.join(root, "opencode.db"),
  ].sort());
  assert.ok(inputs.every((input) => input.adapter === "opencode"));
  assert.equal(isOpenCodeDbPath("/tmp/custom/opencode-copy.db"), true);
  assert.equal(isOpenCodeDbPath("/tmp/custom/opencode-copy.db-wal"), false);
  assert.equal(isOpenCodeDbPath("/tmp/custom/session.jsonl"), false);
});

test("reads model-role messages from top-level active sessions, uses providerID, and reprices tokens", () => {
  const home = tempHome();
  const file = Path.join(home, "opencode.db");
  createDb(file, (db) => {
    addSession(db, "top", null, "/tmp/top");
    addSession(db, "child", "top", "/tmp/child");
    addSession(db, "archived", null, "/tmp/archived", 1_700_000_000_001);
    const insert = db.prepare("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
    insert.run("m-top", "top", 1_700_000_000_100, JSON.stringify({
      role: "model",
      providerID: "anthropic",
      modelID: "claude-opus-4-8",
      cost: 999,
      tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
    }));
    insert.run("m-child", "child", 1_700_000_000_101, JSON.stringify({
      role: "assistant", providerID: "child", modelID: "child-model",
      tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
    insert.run("m-archived", "archived", 1_700_000_000_102, JSON.stringify({
      role: "assistant", providerID: "archived", modelID: "archived-model",
      tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
  });

  const report = newReport();
  const session = sessionFor(file);
  processOpenCodeDb(file, report, options(), session);

  assert.equal(session.kind, "db");
  assert.equal(report.total.requests, 1);
  const event = report._usageEvents[0];
  assert.equal(event.provider, "anthropic");
  assert.equal(event.agent, "opencode");
  assert.equal(event.model, "claude-opus-4-8");
  assert.equal(event.serviceMode, "unknown");
  assert.deepEqual(event.usage, {
    input: 10,
    cacheCreate5m: 5,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 4,
    output: 20,
    reasoningOutput: 3,
    contextWindow: 0,
    inputIncludesCacheRead: false,
  });
  assert.notEqual(event.cost.amount, 999);
  assert.equal(event.cost.known, true);
});

test("does not infer fast service mode from an OpenCode model name", () => {
  const home = tempHome();
  const file = Path.join(home, "opencode.db");
  createDb(file, (db) => {
    addSession(db, "top", null, "/tmp/top");
    db.prepare("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
      "m-fast",
      "top",
      1_700_000_000_100,
      JSON.stringify({
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude-opus-4-8-fast",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    );
  });

  const report = newReport();
  processOpenCodeDb(file, report, options(), sessionFor(file));
  assert.equal(report._usageEvents[0].serviceMode, "unknown");
  assert.equal(report._usageEvents[0].cost.amount, 0.00003);
});

test("isolates malformed message data in lenient mode and throws in strict mode", () => {
  const home = tempHome();
  const file = Path.join(home, "opencode.db");
  createDb(file, (db) => {
    addSession(db, "top", null, "/tmp/top");
    const insert = db.prepare("INSERT INTO message(id, session_id, time_created, data) VALUES (?, ?, ?, ?)");
    insert.run("m-bad", "top", 1_700_000_000_100, "{not-json");
    insert.run("m-good", "top", 1_700_000_000_101, JSON.stringify({
      role: "assistant", providerID: "unknown-provider", modelID: "unknown-model",
      tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    }));
  });

  const lenientReport = newReport();
  const lenientSession = sessionFor(file);
  processOpenCodeDb(file, lenientReport, options(), lenientSession);
  assert.equal(lenientReport.total.requests, 1);
  assert.equal(lenientReport.sources.parseErrors, 1);
  assert.equal(lenientSession.parseErrors, 1);

  assert.throws(
    () => processOpenCodeDb(file, newReport(), options({ strictJson: true }), sessionFor(file)),
    /Malformed OpenCode|Invalid JSON|Unexpected token/,
  );
});
