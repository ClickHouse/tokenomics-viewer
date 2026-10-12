"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");
const { createLineProcessor, newReport, syncDatabase } = require("../app");
const { ANALYTICS_DERIVATION_VERSION } = require("../lib/core/derivation");
const { defaultOptions } = require("./support/fixtures");
const { claudeHistoryRecord } = require("./support/claude-history");

test("Claude history copies with zero totals ignore stale nested token details", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "claude-history");
  processLine(claudeHistoryRecord({ replay: true }), 1);

  assert.equal(report.total.requests, 0);
  assert.equal(report._usageEvents.length, 0);
  assert.deepEqual(processLine.checkpoint().recentRequestIds, []);

  processLine(claudeHistoryRecord(), 2);
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 2);
  assert.equal(report.total.cacheCreate5m, 2618);
  assert.equal(report.total.cacheRead, 86024);
  assert.equal(report.total.output, 12437);
  assert.equal(report.total.reasoningOutput, 12064);
});

test("Claude zero-usage copies do not suppress billed usage across a checkpoint", () => {
  const sourceLabel = "claude-replay-checkpoint";
  const prefix = createLineProcessor(newReport(), defaultOptions(), sourceLabel);
  prefix(claudeHistoryRecord({ replay: true }), 1);
  const report = newReport();
  const resumed = createLineProcessor(report, defaultOptions({ parserCheckpoint: prefix.checkpoint() }), sourceLabel);
  resumed(claudeHistoryRecord(), 2);
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.cacheCreate5m, 2618);
});

test("Claude cache-only usage and partial usage with nested cache counts remain billable", () => {
  for (const usage of [
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 50 },
    { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 },
    { input_tokens: 0, output_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 50 } },
  ]) {
    const report = newReport();
    const processLine = createLineProcessor(report, defaultOptions(), "claude-cache-only");
    const record = JSON.parse(claudeHistoryRecord());
    record.message.usage = usage;
    processLine(JSON.stringify(record), 1);
    assert.equal(report.total.requests, 1);
    assert.equal(report.total.cacheRead + report.total.cacheCreate5m + report.total.cacheCreate1h, 50);
  }
});

test("SQLite imports billed Claude usage alongside zeroed history copies", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-claude-history-"));
  const original = Path.join(tmp, "original.jsonl");
  const copy = Path.join(tmp, "copy.jsonl");
  fs.writeFileSync(original, `${claudeHistoryRecord()}\n`);
  fs.writeFileSync(copy, `${claudeHistoryRecord({ replay: true })}\n`);
  const report = await syncDatabase(defaultOptions({ db: Path.join(tmp, "data.sqlite"), paths: [original, copy] }));
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 2);
  assert.equal(report.total.cacheCreate5m, 2618);
  assert.equal(report.total.output, 12437);
  assert.equal(report.sources.conflictingUsageEvents, 0);
});

test("SQLite replays legacy Claude history rows once even when source bytes are unchanged", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-claude-history-migration-"));
  const original = Path.join(tmp, "original.jsonl");
  const copy = Path.join(tmp, "copy.jsonl");
  const dbPath = Path.join(tmp, "data.sqlite");
  fs.writeFileSync(original, `${claudeHistoryRecord()}\n`);
  fs.writeFileSync(copy, `${claudeHistoryRecord({ replay: true })}\n`);
  const options = defaultOptions({ db: dbPath, paths: [original, copy] });
  await syncDatabase(options);

  const stored = new DatabaseSync(dbPath);
  try {
    const originalRow = stored.prepare("SELECT * FROM usage_events WHERE source_path = ?").get(original);
    const legacyRow = { ...originalRow, source_path: copy, input: 0, cache_read: 0, output: 0, reasoning_output: 0, payload_hash: "" };
    delete legacyRow.id;
    const columns = Object.keys(legacyRow);
    stored.prepare(`INSERT INTO usage_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => legacyRow[column]));
    stored.prepare("UPDATE sources SET fingerprint = replace(fingerprint, ?, ?)").run(
      `analyticsDerivationVersion=${ANALYTICS_DERIVATION_VERSION}`,
      "analyticsDerivationVersion=8",
    );
  } finally {
    stored.close();
  }

  const report = await syncDatabase(options);
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.cacheCreate5m, 2618);
  const check = new DatabaseSync(dbPath);
  try {
    assert.equal(check.prepare("SELECT count(*) AS count FROM usage_events").get().count, 1);
    assert.equal(check.prepare("SELECT count(*) AS count FROM sources WHERE fingerprint LIKE '%analyticsDerivationVersion=8%'").get().count, 0);
  } finally {
    check.close();
  }
  assert.equal((await syncDatabase(options)).total.requests, 1);
});

test("SQLite still rejects conflicting nonzero Claude usage for the same UUID", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-claude-real-conflict-"));
  const paths = [Path.join(tmp, "first.jsonl"), Path.join(tmp, "second.jsonl")];
  fs.writeFileSync(paths[0], `${claudeHistoryRecord()}\n`);
  fs.writeFileSync(paths[1], `${claudeHistoryRecord({ input: 3 })}\n`);
  await assert.rejects(syncDatabase(defaultOptions({ db: Path.join(tmp, "data.sqlite"), paths })), /Conflicting stored usage event/);
});
