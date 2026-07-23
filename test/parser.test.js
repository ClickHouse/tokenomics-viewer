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

test("skips exact duplicate last_token_usage snapshots within one turn", () => {
  const report = newReport();
  const processLine = createLineProcessor(report, defaultOptions(), "codex-last-usage-duplicate-fixture");

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:00:01.000Z",
    payload: { turn_id: "019f0000-0000-0000-0000-000000000051", cwd: "/tmp/last-usage-duplicate", model: "gpt-5-codex" },
  }), 1);

  const duplicate = {
    type: "event_msg",
    timestamp: "2026-07-05T00:00:02.000Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
      },
    },
  };
  processLine(JSON.stringify(duplicate), 2);
  processLine(JSON.stringify({ ...duplicate, timestamp: "2026-07-05T00:00:03.000Z" }), 3);

  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-05T00:01:01.000Z",
    payload: { turn_id: "019f0000-0000-0000-0000-000000000052", cwd: "/tmp/last-usage-duplicate", model: "gpt-5-codex" },
  }), 4);
  processLine(JSON.stringify({
    ...duplicate,
    timestamp: "2026-07-05T00:01:02.000Z",
  }), 5);

  assert.equal(report.sources.tokenCountSnapshots, 3);
  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 160);
  assert.equal(report.total.cacheRead, 40);
  assert.equal(report.total.output, 20);
});

test("omp malformed JSON is counted in lenient mode and rejected in strict mode", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-omp-parse-test-"));
  const ompHome = Path.join(tmp, "omp-home");
  const sessions = Path.join(ompHome, "sessions", "-tmp-project-omp");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(Path.join(sessions, "malformed.jsonl"), [
    JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-07-23T00:40:00.000Z", cwd: "/tmp/project-omp", title: "t" }),
    JSON.stringify({
      type: "message", id: "m1", timestamp: "2026-07-23T00:42:17.380Z",
      message: { role: "assistant", content: [] }, provider: "zai", model: "glm-5.2",
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0 } },
      timestamp: 1784767330214,
    }),
    "{malformed-json",
    "",
  ].join("\n"));

  const lenient = await buildReport(defaultOptions({ source: "omp", home: tmp, ompHome }));
  assert.equal(lenient.sources.parseErrors, 1);
  assert.equal(lenient.sessions[0].parseErrors, 1);

  await assert.rejects(
    () => buildReport(defaultOptions({ source: "omp", home: tmp, ompHome, strictJson: true })),
    /Invalid JSON in .*malformed\.jsonl:3/,
  );
});

test("omp discovery ingests parent transcripts and subagent sidecars (A6)", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-omp-tree-test-"));
  const ompHome = Path.join(tmp, "omp-home");
  const slug = Path.join(ompHome, "sessions", "-tmp-project-omp");
  fs.mkdirSync(slug, { recursive: true });
  const parentFile = Path.join(slug, "2026-07-23T00-40-00-000Z_019f8c6a.jsonl");
  const sidecarDir = Path.join(slug, "2026-07-23T00-40-00-000Z_019f8c6a");
  fs.mkdirSync(sidecarDir, { recursive: true });
  const sidecarFile = Path.join(sidecarDir, "SubAgent.jsonl");

  const header = (cwd) => JSON.stringify({ type: "session", version: 3, id: cwd.slice(-4), timestamp: "2026-07-23T00:40:00.000Z", cwd, title: "t" });
  const assistant = () => JSON.stringify({
    type: "message", id: "m", timestamp: "2026-07-23T00:42:17.380Z",
    message: { role: "assistant", content: [] }, provider: "zai", model: "glm-5.2",
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0 } },
    timestamp: 1784767330214,
  });

  fs.writeFileSync(parentFile, [header("/tmp/project-omp"), assistant(), ""].join("\n"));
  fs.writeFileSync(sidecarFile, [header("/tmp/sidecar-project"), assistant(), ""].join("\n"));

  const report = await buildReport(defaultOptions({ source: "omp", home: tmp, ompHome }));
  assert.equal(report.sessions.length, 2);
  assert.equal(report.total.requests, 2);
  assert.equal(report.providers["omp"].requests, 2);
  assert.ok(report.providerModels["omp/glm-5.2"]);
  assert.equal(report.projects["/tmp/project-omp"].requests, 1);
  assert.equal(report.projects["/tmp/sidecar-project"].requests, 1);
});
