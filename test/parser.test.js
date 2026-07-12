"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { buildReport, createLineProcessor, newReport } = require("../app");
const { defaultOptions } = require("./support/fixtures");

test("buildReport scans explicit JSONL path and zip archives", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-c", model: "gpt-5.4-mini" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 0,
            output_tokens: 1_000_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const zipPath = Path.join(tmp, "sessions.zip");
  execFileSync("zip", ["-q", zipPath, "session.jsonl"], { cwd: tmp });

  const report = await buildReport(defaultOptions({ paths: [zipPath] }));
  assert.equal(report.sources.zipFiles, 1);
  assert.equal(report.sources.zipEntries, 1);
  assert.equal(report.models["gpt-5.4-mini"].requests, 1);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 5.25);
});

test("default Codex discovery reads archived JSONL and compressed rollout files", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-codex-home-test-"));
  const codexHome = Path.join(tmp, "custom-codex-home");
  const sessions = Path.join(codexHome, "sessions", "2026", "07", "12");
  const archived = Path.join(codexHome, "archived_sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archived, { recursive: true });

  const rollout = (timestamp, cwd) => [
    JSON.stringify({ type: "turn_context", timestamp, payload: { cwd, model: "gpt-5.4-mini" } }),
    JSON.stringify({
      type: "event_msg",
      timestamp,
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 } },
      },
    }),
    "",
  ].join("\n");

  const activeRollout = rollout("2026-07-12T10:00:00.000Z", "/tmp/active");
  fs.writeFileSync(
    Path.join(sessions, "rollout-active.jsonl.zst"),
    zlib.zstdCompressSync(activeRollout),
  );
  fs.writeFileSync(
    Path.join(archived, "rollout-archived.jsonl"),
    rollout("2026-07-11T10:00:00.000Z", "/tmp/archived"),
  );

  const report = await buildReport(defaultOptions({ source: "codex", home: tmp, codexHome }));
  assert.equal(report.sessions.length, 2);
  assert.equal(report.total.requests, 2);

  const activeOnly = await buildReport(defaultOptions({
    source: "codex",
    home: tmp,
    codexHome,
    includeArchives: false,
  }));
  assert.equal(activeOnly.sessions.length, 1);
  assert.match(activeOnly.sessions[0].path, /rollout-active\.jsonl\.zst$/);

  fs.writeFileSync(Path.join(sessions, "rollout-active.jsonl"), activeRollout);
  const transition = await buildReport(defaultOptions({ source: "codex", home: tmp, codexHome }));
  assert.equal(transition.sessions.length, 2, "plain and compressed siblings must represent one rollout");
});

test("malformed JSON is counted in lenient mode and rejected in strict mode", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-parse-error-test-"));
  const jsonl = Path.join(tmp, "malformed.jsonl");
  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/parser-test", model: "gpt-5-codex" },
    }),
    "{malformed-json",
    "",
  ].join("\n"));

  const lenient = await buildReport(defaultOptions({ paths: [jsonl] }));
  assert.equal(lenient.sources.parseErrors, 1);
  assert.equal(lenient.sessions[0].parseErrors, 1);

  await assert.rejects(
    () => buildReport(defaultOptions({ paths: [jsonl], strictJson: true })),
    /Invalid JSON in .*malformed\.jsonl:2/,
  );
});

test("falls back to one clean turn metric when request chars include tool payloads", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-output-char-outlier-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000021", cwd: "/tmp/output-char-outlier", model: "gpt-5-codex" },
  }), 1);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "abcdefghij" }] },
  }), 2);
  processLine(JSON.stringify({
    type: "response_item",
    timestamp: "2026-07-05T00:00:03.000Z",
    payload: { type: "function_call", name: "exec_command", arguments: "x".repeat(100) },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-05T00:00:04.000Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 1 } },
    },
  }), 4);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:01:01.000Z",
    payload: { turn_id: "019f0000-0000-7000-8000-000000000022", cwd: "/tmp/output-char-outlier", model: "gpt-5-codex" },
  }), 5);

  assert.equal(report._outputCharMetrics.length, 1);
  assert.equal(report.total.outputCharTokenOutliers, 0);
  assert.equal(report.total.outputCharTokenSamples, 1);
});
