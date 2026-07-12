"use strict";

const assert = require("node:assert/strict");
const ChildProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const Path = require("node:path");
const test = require("node:test");
const { main, parseArgs } = require("../app");
const cli = require("../lib/cli");
const { defaultOptions, roundCosts } = require("./support/fixtures");

test("parseArgs keeps stdout JSON clean unless progress is explicit", () => {
  assert.equal(parseArgs(["--json"]).progress, false);
  assert.equal(parseArgs(["--json", "--progress"]).progress, true);

  const outputOptions = parseArgs(["--output", "report.json"]);
  assert.equal(outputOptions.format, "json");
  assert.equal(outputOptions.progress, true);
});

test("parseArgs accepts ClickHouse database backend options", () => {
  const options = parseArgs([
    "--db-engine", "clickhouse",
    "--clickhouse-url", "http://127.0.0.1:8123",
    "--clickhouse-database", "tokenomics_test",
    "--clickhouse-user", "default",
    "--clickhouse-password", "secret",
    "--clickhouse-insert-batch-rows", "12345",
    "--clickhouse-insert-batch-bytes", "8MiB",
    "--clickhouse-reset",
  ]);

  assert.equal(options.dbEngine, "clickhouse");
  assert.equal(options.clickhouseUrl, "http://127.0.0.1:8123");
  assert.equal(options.clickhouseDatabase, "tokenomics_test");
  assert.equal(options.clickhouseUser, "default");
  assert.equal(options.clickhousePassword, "secret");
  assert.equal(options.clickhouseInsertBatchRows, 12_345);
  assert.equal(options.clickhouseInsertBatchBytes, 8 * 1024 * 1024);
  assert.equal(options.clickhouseReset, true);
});

test("default options honor CODEX_HOME for Codex session discovery", () => {
  const options = cli.defaultOptions({ CODEX_HOME: "/tmp/custom-codex-home" });
  assert.equal(options.codexHome, Path.resolve("/tmp/custom-codex-home"));
});
test("main writes final JSON report with per-session metrics", async () => {
  const tmp = fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-output-test-"));
  const jsonl = Path.join(tmp, "session.jsonl");
  const output = Path.join(tmp, "report.json");

  fs.writeFileSync(jsonl, [
    JSON.stringify({
      type: "turn_context",
      timestamp: "2026-07-05T00:00:00.000Z",
      payload: { cwd: "/tmp/project-d", model: "gpt-5-codex" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-07-05T00:00:01.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 1_000_000,
            cached_input_tokens: 100_000,
            output_tokens: 200_000,
          },
          model_context_window: 128_000,
        },
      },
    }),
    "",
  ].join("\n"));

  const report = await main(["--no-progress", "--output", output, jsonl]);
  const written = JSON.parse(fs.readFileSync(output, "utf8"));

  assert.equal(report.sessions.length, 1);
  assert.equal(written.sessions.length, 1);
  assert.equal(written.sessions[0].path, jsonl);
  assert.equal(written.sessions[0].lines, 2);
  assert.equal(written.sessions[0].records, 2);
  assert.equal(written.sessions[0].stats.requests, 1);
  assert.equal(written.sessions[0].stats.input, 900_000);
  assert.equal(written.sessions[0].stats.cacheRead, 100_000);
  assert.equal(written.sessions[0].stats.output, 200_000);
  assert.equal(Number(written.sessions[0].stats.costUsd.toFixed(6)), 3.1375);
  assert.deepEqual(roundCosts(written.sessions[0].stats.costsUsd), {
    input: 1.125,
    cacheCreate5m: 0,
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: 0.0125,
    output: 2,
  });
  assert.ok(written.sessions[0].durationMs >= 0);
});

test("parseArgs rejects invalid values across the supported validation matrix", () => {
  const invalidCases = [
    [["--source", "invalid"], "--source must be all, claude, or codex"],
    [["--openai-context", "invalid"], "--openai-context must be auto, short, or long"],
    [["--format", "xml"], "--format must be text or json"],
    [["--db-engine", "invalid"], "--db-engine must be sqlite or clickhouse"],
    [["--clickhouse-url", "not-a-url"], "--clickhouse-url must be a valid URL"],
    [["--clickhouse-database", "bad-name"], "--clickhouse-database must be a non-empty ClickHouse identifier"],
    [["--clickhouse-insert-batch-rows", "0"], "--clickhouse-insert-batch-rows must be a positive integer"],
    [["--clickhouse-insert-batch-bytes", "0"], "--clickhouse-insert-batch-bytes must be a positive byte size"],
    [["--top", "0"], "--top must be a positive number"],
    [["--limit-files", "0"], "--limit-files must be a positive number"],
    [["--port", "65536"], "--port must be an integer from 0 to 65535"],
  ];

  for (const [argv, message] of invalidCases) {
    assert.throws(() => parseArgs(argv), { message });
  }
});

test("CLI module keeps aliases and environment defaults while help stays pure", () => {
  const env = {
    TOKENOMICS_DB_ENGINE: "clickhouse",
    TOKENOMICS_CLICKHOUSE_URL: "http://example.test:8123",
    TOKENOMICS_CLICKHOUSE_DATABASE: "cli_test",
    TOKENOMICS_CLICKHOUSE_INSERT_BATCH_ROWS: "17",
    TOKENOMICS_CLICKHOUSE_INSERT_BATCH_BYTES: "2MiB",
  };
  const options = cli.parseArgs(["-o", "report.json", "--source=codex", "--no-archives"], env);

  assert.equal(options.output, Path.resolve("report.json"));
  assert.equal(options.format, "json");
  assert.equal(options.source, "codex");
  assert.equal(options.includeArchives, false);
  assert.equal(options.dbEngine, "clickhouse");
  assert.equal(options.clickhouseUrl, env.TOKENOMICS_CLICKHOUSE_URL);
  assert.equal(options.clickhouseDatabase, "cli_test");
  assert.equal(options.clickhouseInsertBatchRows, 17);
  assert.equal(options.clickhouseInsertBatchBytes, 2 * 1024 * 1024);

  const help = cli.parseArgs(["--help"], env);
  assert.equal(help.help, true);
  assert.match(cli.helpText(), /Usage: node app\.js/);
});

test("app parseArgs preserves the legacy help output and exit contract", () => {
  const result = ChildProcess.spawnSync(
    process.execPath,
    ["-e", 'require("./app").parseArgs(["--help"]); console.log("unreachable");'],
    { cwd: Path.resolve(__dirname, ".."), encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^Usage: node app\.js \[options\] \[paths\.\.\.\]/);
  assert.doesNotMatch(result.stdout, /unreachable/);
});

test("the executable keeps its successful --help behavior", () => {
  const result = ChildProcess.spawnSync(
    process.execPath,
    ["app.js", "--help"],
    { cwd: Path.resolve(__dirname, ".."), encoding: "utf8" },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${cli.helpText()}\n`);
});
