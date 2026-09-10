"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { buildReport, createLineProcessor, newReport } = require("../app");
const { defaultOptions } = require("./support/fixtures");

test("skips replayed parent transcript in forked Codex sessions", () => {
  const report = newReport();
  const telemetry = [];
  report._telemetryEventSink = (event) => telemetry.push(event);
  const parentSessionId = "019d39a3-df16-7c62-9614-4dcf15617287";
  const childSessionId = "019d4cf5-4803-7eb1-a490-19abc40e6a59";
  const parentTurnId = "019d39a7-67c2-7363-aa28-0b83b8639593";
  const childTurnId = "019d4cf5-4d1e-79e2-bbb1-686e38bb6ba7";
  const processLine = createLineProcessor(report, defaultOptions({
    codexForkRegistry: {
      tracesBySession: new Map([[parentSessionId, new Set([`turn:${parentTurnId}`])]]),
      replaySessions: new Set([childSessionId]),
    },
  }), "codex-fork-fixture");
  const parentInfo = {
    total_token_usage: {
      input_tokens: 9_000_000,
      cached_input_tokens: 8_000_000,
      output_tokens: 900_000,
    },
    last_token_usage: {
      input_tokens: 9_000_000,
      cached_input_tokens: 8_000_000,
      output_tokens: 900_000,
    },
    model_context_window: 128_000,
  };
  const childInfo = {
    total_token_usage: {
      input_tokens: 10_000_000,
      cached_input_tokens: 8_100_000,
      output_tokens: 1_100_000,
      reasoning_output_tokens: 50_000,
    },
    last_token_usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 100_000,
      output_tokens: 200_000,
      reasoning_output_tokens: 50_000,
    },
    model_context_window: 128_000,
  };

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-04-02T06:50:36.530Z",
    payload: {
      id: childSessionId,
      forked_from_id: parentSessionId,
      cwd: "/tmp/child-project",
      model_provider: "openai",
    },
  }), 1);
  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-04-02T06:50:36.531Z",
    payload: {
      id: parentSessionId,
      cwd: "/tmp/parent-project",
      model_provider: "openai",
    },
  }), 2);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-04-02T06:50:36.532Z",
    payload: { turn_id: parentTurnId, cwd: "/tmp/parent-project", model: "gpt-5.5", effort: "high" },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:36.533Z",
    payload: { type: "token_count", info: parentInfo },
  }), 4);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:36.534Z",
    payload: { type: "token_count", info: parentInfo },
  }), 5);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:37.727Z",
    payload: { type: "task_started", turn_id: childTurnId },
  }), 6);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-04-02T06:50:38.253Z",
    payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex", effort: "xhigh" },
  }), 7);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:38.507Z",
    payload: { type: "token_count", info: childInfo },
  }), 8);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:39.507Z",
    payload: { type: "token_count", info: childInfo },
  }), 9);

  assert.equal(report.sources.tokenCountSnapshots, 2);
  assert.equal(report.sources.skippedTokenCountSnapshots, 1);
  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 900_000);
  assert.equal(report.total.cacheRead, 100_000);
  assert.equal(report.total.output, 200_000);
  assert.equal(report.total.reasoningOutput, 50_000);
  assert.equal(report.projects["/tmp/parent-project"], undefined);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
  assert.equal(report.models["gpt-5.5"], undefined);
  assert.equal(report.models["gpt-5-codex"].requests, 1);
  assert.equal(report.efforts.xhigh.requests, 1);
  assert.equal(Number(report.total.costUsd.toFixed(6)), 3.1375);
  assert.equal(telemetry.length, 4);
  assert.ok(telemetry.every((event) => event.eventKind === "usage_snapshot"));
});

test("normalizes uppercase fork parent IDs before parent trace lookup", () => {
  const report = newReport();
  const parentSessionId = "019d39a3-df16-7c62-9614-4dcf15617287";
  const childSessionId = "019d4cf5-4803-7eb1-a490-19abc40e6a59";
  const parentTurnId = "019d39a7-67c2-7363-aa28-0b83b8639593";
  const childTurnId = "019d4cf5-4d1e-79e2-bbb1-686e38bb6ba7";
  const processLine = createLineProcessor(report, defaultOptions({
    codexForkRegistry: {
      tracesBySession: new Map([[parentSessionId, new Set([`turn:${parentTurnId}`])]]),
      replaySessions: new Set(),
    },
  }), "codex-uppercase-parent-fixture");

  const tokenCount = (input, output) => ({
    type: "event_msg",
    timestamp: "2026-04-02T06:50:36.533Z",
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } },
    },
  });

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-04-02T06:50:36.530Z",
    payload: {
      id: childSessionId,
      forked_from_id: parentSessionId.toUpperCase(),
      cwd: "/tmp/child-project",
      model_provider: "openai",
    },
  }), 1);
  processLine(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: parentTurnId } }), 2);
  processLine(JSON.stringify(tokenCount(900, 90)), 3);
  processLine(JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: childTurnId } }), 4);
  processLine(JSON.stringify(tokenCount(50, 5)), 5);

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 50);
  assert.equal(report.total.output, 5);
});

test("skips inherited snapshots in a child-only log when the parent source is missing", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-missing-parent-test-"));
  const child = Path.join(tmp, "child.jsonl");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "81f2c4e4-a0a3-483f-8540-7beb1572ff60";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";

  fs.writeFileSync(child, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:01:00.000Z", payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:00.500Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 }, total_token_usage: { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 } } } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:01.000Z", payload: { type: "task_started", turn_id: parentTurnId } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-09T20:01:03.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:04.000Z", payload: { type: "task_started", turn_id: childTurnId } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-07-09T20:01:05.000Z", payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-07-09T20:01:06.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 }, total_token_usage: { input_tokens: 150, cached_input_tokens: 135, output_tokens: 15 } } } }),
    "",
  ].join("\n"));

  const report = await buildReport(defaultOptions({ paths: [child] }));

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 5);
  assert.equal(report.total.cacheRead, 45);
  assert.equal(report.total.output, 5);
  assert.equal(report.projects["/tmp/parent-project"], undefined);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
});

test("uses the initial child cwd and matching turn trace when parent metadata is absent", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-no-parent-meta-test-"));
  const child = Path.join(tmp, "child.jsonl");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "81f2c4e4-a0a3-483f-8540-7beb1572ff60";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";
  const tokenCount = (timestamp, last, total) => ({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: last,
        total_token_usage: total,
      },
    },
  });

  fs.writeFileSync(child, [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-11T00:00:00.000Z",
      payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" },
    }),
    JSON.stringify(tokenCount(
      "2026-07-11T00:00:01.000Z",
      { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 },
      { input_tokens: 999, cached_input_tokens: 900, output_tokens: 99 },
    )),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-11T00:00:02.000Z",
      payload: { type: "task_started", turn_id: parentTurnId },
    }),
    JSON.stringify(tokenCount(
      "2026-07-11T00:00:03.000Z",
      { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
      { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
    )),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-11T00:00:04.000Z",
      payload: { type: "task_started", turn_id: childTurnId },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-11T00:00:05.000Z",
      payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex" },
    }),
    JSON.stringify(tokenCount(
      "2026-07-11T00:00:06.000Z",
      { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 },
      { input_tokens: 150, cached_input_tokens: 135, output_tokens: 15 },
    )),
    "",
  ].join("\n"));

  const report = await buildReport(defaultOptions({ paths: [child] }));

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 5);
  assert.equal(report.total.cacheRead, 45);
  assert.equal(report.total.output, 5);
  assert.equal(report.projects["/tmp/parent-project"], undefined);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
});

test("counts a child that starts directly when its cwd boundary has no replay prefix", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-direct-child-test-"));
  const child = Path.join(tmp, "child.jsonl");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";

  fs.writeFileSync(child, [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-11T00:00:00.000Z",
      payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/direct-child-project" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-11T00:00:01.000Z",
      payload: { type: "task_started", turn_id: childTurnId },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-11T00:00:02.000Z",
      payload: { turn_id: childTurnId, cwd: "/tmp/direct-child-project", model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-11T00:00:03.000Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 } },
      },
    }),
    "",
  ].join("\n"));

  const report = await buildReport(defaultOptions({ paths: [child] }));

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 5);
  assert.equal(report.total.cacheRead, 45);
  assert.equal(report.total.output, 5);
  assert.equal(report.projects["/tmp/direct-child-project"].requests, 1);
});

test("skips untraced usage before a missing-parent child cwd boundary", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-untraced-prefix-test-"));
  const child = Path.join(tmp, "child.jsonl");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";

  fs.writeFileSync(child, [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-11T00:00:00.000Z",
      payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-11T00:00:01.000Z",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 999, output_tokens: 1 } } },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-11T00:00:02.000Z",
      payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-11T00:00:03.000Z",
      payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, output_tokens: 5 } } },
    }),
    "",
  ].join("\n"));

  const report = await buildReport(defaultOptions({ paths: [child] }));

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 50);
  assert.equal(report.total.output, 5);
});

test("fails closed when a missing-parent child has no explicit boundary", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-no-boundary-test-"));
  const child = Path.join(tmp, "child.jsonl");
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";

  fs.writeFileSync(child, [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-11T00:00:00.000Z",
      payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/ambiguous-child-project" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-11T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 } },
      },
    }),
    "",
  ].join("\n"));

  const report = await buildReport(defaultOptions({ paths: [child] }));

  assert.equal(report.total.requests, 0);
  assert.equal(report.projects["/tmp/ambiguous-child-project"], undefined);
});

test("skips parent traces replayed before their session metadata in a subagent log", () => {
  const report = newReport();
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "81f2c4e4-a0a3-483f-8540-7beb1572ff60";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";
  const processLine = createLineProcessor(report, defaultOptions({
    codexForkRegistry: {
      tracesBySession: new Map([[parentSessionId, new Set([
        `turn:${parentTurnId}`,
        "call:call_parent_patch",
      ])]]),
      replaySessions: new Set([childSessionId]),
    },
  }), "codex-fork-prefix-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-10T00:35:30.110Z",
    payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project", model_provider: "openai" },
  }), 1);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.1105Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 999_000, cached_input_tokens: 900_000, output_tokens: 99_000 },
        total_token_usage: { input_tokens: 999_000, cached_input_tokens: 900_000, output_tokens: 99_000 },
      },
    },
  }), 2);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.111Z",
    payload: { type: "task_started", turn_id: parentTurnId },
  }), 3);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.112Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 10_000 },
        total_token_usage: { input_tokens: 1_000_000, cached_input_tokens: 900_000, output_tokens: 10_000 },
      },
    },
  }), 4);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.113Z",
    payload: { type: "patch_apply_end", turn_id: parentTurnId, call_id: "call_parent_patch" },
  }), 5);
  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-07-10T00:35:30.114Z",
    payload: { id: parentSessionId, cwd: "/tmp/parent-project", model_provider: "openai" },
  }), 6);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.115Z",
    payload: { type: "task_started", turn_id: childTurnId },
  }), 7);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-07-10T00:35:30.116Z",
    payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex", effort: "high" },
  }), 8);
  processLine(JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-10T00:35:30.117Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
        total_token_usage: { input_tokens: 1_000_100, cached_input_tokens: 900_050, output_tokens: 10_020 },
      },
    },
  }), 9);

  assert.equal(report.total.requests, 1);
  assert.equal(report.total.input, 50);
  assert.equal(report.total.cacheRead, 50);
  assert.equal(report.total.output, 20);
  assert.equal(report.projects["/tmp/parent-project"], undefined);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
});

test("skips replayed parent traces in archived Codex ZIP sessions", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-fork-zip-test-"));
  const parentSessionId = "019f48d9-4ccc-73c2-bf45-a84e4951347e";
  const childSessionId = "019f4973-7053-7623-a798-0e4cf81ef014";
  const parentTurnId = "019f48d9-5000-7000-8000-000000000001";
  const childTurnId = "019f4973-70ef-74f1-b3fb-6bb7ef4c5719";
  const parent = Path.join(tmp, "parent.jsonl");
  const child = Path.join(tmp, "child.jsonl");
  const zipPath = Path.join(tmp, "sessions.zip");

  fs.writeFileSync(parent, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-02T00:00:00.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-04-02T00:00:01.000Z", payload: { turn_id: parentTurnId, cwd: "/tmp/parent-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:00:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    "",
  ].join("\n"));
  fs.writeFileSync(child, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-02T00:01:00.000Z", payload: { id: childSessionId, forked_from_id: parentSessionId, cwd: "/tmp/child-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:01.000Z", payload: { type: "task_started", turn_id: parentTurnId } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:02.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }, total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 } } } }),
    JSON.stringify({ type: "session_meta", timestamp: "2026-04-02T00:01:03.000Z", payload: { id: parentSessionId, cwd: "/tmp/parent-project" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:04.000Z", payload: { type: "task_started", turn_id: childTurnId } }),
    JSON.stringify({ type: "turn_context", timestamp: "2026-04-02T00:01:05.000Z", payload: { turn_id: childTurnId, cwd: "/tmp/child-project", model: "gpt-5-codex" } }),
    JSON.stringify({ type: "event_msg", timestamp: "2026-04-02T00:01:06.000Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 }, total_token_usage: { input_tokens: 150, cached_input_tokens: 135, output_tokens: 15 } } } }),
    "",
  ].join("\n"));
  execFileSync("zip", ["-q", zipPath, Path.basename(parent), Path.basename(child)], { cwd: tmp });

  const report = await buildReport(defaultOptions({ paths: [zipPath] }));
  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 15);
  assert.equal(report.total.cacheRead, 135);
  assert.equal(report.total.output, 15);
  assert.equal(report.projects["/tmp/parent-project"].requests, 1);
  assert.equal(report.projects["/tmp/child-project"].requests, 1);
});

test("uses last usage as the first baseline for an August 8 paginated subagent", () => {
  const report = newReport();
  const childSessionId = "019fe2c8-0226-7d51-ab63-ebaf20a840c8";
  const parentSessionId = "019fb815-3dfa-7693-bd58-8d61c9d0784f";
  const processLine = createLineProcessor(report, defaultOptions(), "codex-migrated-fork-fixture");

  const tokenCount = (timestamp, total, last) => JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
    },
  });

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-08T19:09:46.579Z",
    payload: {
      id: childSessionId,
      parent_thread_id: parentSessionId,
      cwd: "/tmp/migrated-fork",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentSessionId,
          },
        },
      },
      history_mode: "paginated",
      subagent_history_start_ordinal: 202,
    },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-08T19:09:46.579Z",
    payload: {
      turn_id: "01a05a1f-c000-7000-8000-000000000001",
      cwd: "/tmp/migrated-fork",
      model: "gpt-5-codex",
    },
  }), 2);
  processLine(tokenCount(
    "2026-08-08T19:09:46.579Z",
    { input_tokens: 59_108_282, cached_input_tokens: 57_617_152, output_tokens: 143_257, reasoning_output_tokens: 69_382 },
    { input_tokens: 198_685, cached_input_tokens: 11_008, output_tokens: 347, reasoning_output_tokens: 121 },
  ), 3);
  processLine(tokenCount(
    "2026-08-08T19:09:46.579Z",
    { input_tokens: 59_108_282, cached_input_tokens: 57_617_152, output_tokens: 143_257, reasoning_output_tokens: 69_382 },
    { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
  ), 4);
  processLine(tokenCount(
    "2026-08-08T19:09:46.579Z",
    { input_tokens: 59_144_504, cached_input_tokens: 57_623_040, output_tokens: 143_752, reasoning_output_tokens: 69_597 },
    { input_tokens: 36_222, cached_input_tokens: 5_888, output_tokens: 495, reasoning_output_tokens: 215 },
  ), 5);

  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 218_011);
  assert.equal(report.total.cacheRead, 16_896);
  assert.equal(report.total.output, 842);
  assert.equal(report.total.reasoningOutput, 336);
  assert.equal(report.sources.skippedTokenCountSnapshots, 1);
});

test("uses owned token usage records and ignores paired aggregate token counts", () => {
  const report = newReport();
  const childSessionId = "01a07682-5e9a-72d0-b128-35db975c5156";
  const parentSessionId = "01a07680-0000-7000-8000-000000000001";
  const processLine = createLineProcessor(report, defaultOptions(), "codex-token-record-fixture");

  processLine(JSON.stringify({
    type: "session_meta",
    timestamp: "2026-09-06T12:00:00.000Z",
    payload: {
      id: childSessionId,
      forked_from_id: null,
      cwd: "/tmp/token-record-child",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentSessionId,
          },
        },
      },
      history_mode: "paginated",
      subagent_history_start_ordinal: 121,
    },
  }), 1);
  processLine(JSON.stringify({
    type: "turn_context",
    timestamp: "2026-09-06T12:00:01.000Z",
    payload: {
      turn_id: "01a07682-6000-7000-8000-000000000002",
      cwd: "/tmp/token-record-child",
      model: "gpt-5-codex",
    },
  }), 2);

  // A copied record from another ownership domain is not evidence of child usage.
  processLine(JSON.stringify({
    type: "token_usage_record",
    timestamp: "2026-09-06T12:00:02.000Z",
    payload: {
      thread_id: parentSessionId,
      response_id: "resp-parent",
      usage: { input_tokens: 9_000_000, cached_input_tokens: 8_000_000, output_tokens: 900_000, total_tokens: 9_900_000 },
    },
  }), 3);

  const usageRecord = (timestamp, responseId, usage) => JSON.stringify({
    type: "token_usage_record",
    timestamp,
    payload: {
      thread_id: childSessionId,
      response_id: responseId,
      usage,
    },
  });
  const pairedTokenCount = (timestamp, total, last) => JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: { total_token_usage: total, last_token_usage: last },
    },
  });

  processLine(usageRecord("2026-09-06T12:00:03.000Z", "resp-child-1", {
    input_tokens: 100,
    cached_input_tokens: 90,
    output_tokens: 10,
    total_tokens: 110,
  }), 4);
  processLine(usageRecord("2026-09-06T12:00:03.050Z", "resp-child-1", {
    input_tokens: 100,
    cached_input_tokens: 90,
    output_tokens: 10,
    total_tokens: 110,
  }), 5);
  processLine(pairedTokenCount(
    "2026-09-06T12:00:03.100Z",
    { input_tokens: 10_000_100, cached_input_tokens: 9_000_090, output_tokens: 1_000_010 },
    { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
  ), 6);
  processLine(usageRecord("2026-09-06T12:00:04.000Z", "resp-child-2", {
    input_tokens: 50,
    cached_input_tokens: 45,
    output_tokens: 5,
    total_tokens: 55,
  }), 7);
  processLine(pairedTokenCount(
    "2026-09-06T12:00:04.100Z",
    { input_tokens: 10_000_150, cached_input_tokens: 9_000_135, output_tokens: 1_000_015 },
    { input_tokens: 50, cached_input_tokens: 45, output_tokens: 5 },
  ), 8);

  assert.equal(report.total.requests, 2);
  assert.equal(report.total.input, 15);
  assert.equal(report.total.cacheRead, 135);
  assert.equal(report.total.output, 15);
  assert.equal(report.sources.tokenCountSnapshots, 2);
  assert.equal(report.sources.skippedTokenCountSnapshots, 2);
  assert.deepEqual(report._usageEvents.map((event) => event.requestId), ["resp-child-1", "resp-child-2"]);
});
