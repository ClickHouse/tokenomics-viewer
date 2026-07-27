"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Path = require("node:path");
const os = require("node:os");
const test = require("node:test");
const { buildReport, discoverInputs } = require("../app");
const { defaultOptions } = require("./support/fixtures");

function tempHome() {
  return fs.mkdtempSync(Path.join(os.tmpdir(), "tokenomics-harnesses-"));
}

function writeJsonl(file, rows) {
  fs.mkdirSync(Path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n");
}

test("discovers Claude config dirs, Desktop nested projects, and exact harness roots", async () => {
  const home = tempHome();
  const configA = Path.join(home, "claude-a");
  const configB = Path.join(home, "claude-b");
  const same = Path.join(configA, "projects", "same", "session.jsonl");
  const sameLink = Path.join(configB, "projects", "same-link", "session.jsonl");
  writeJsonl(same, []);
  fs.mkdirSync(Path.dirname(sameLink), { recursive: true });
  fs.symlinkSync(same, sameLink);
  writeJsonl(Path.join(configB, "projects", "other", "session.jsonl"), []);

  const desktop = Path.join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions", "app", "workspace", "local_1", ".claude", "projects", "desktop-project", "desktop.jsonl");
  writeJsonl(desktop, []);

  writeJsonl(Path.join(home, ".pi", "agent", "sessions", "project", "pi.jsonl"), []);
  writeJsonl(Path.join(home, ".gemini", "tmp", "project", "chats", "session-g.jsonl"), []);
  writeJsonl(Path.join(home, ".qwen", "projects", "project", "chats", "qwen.jsonl"), []);
  const previousDirs = process.env.CLAUDE_CONFIG_DIRS;
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIRS = `${configA}${Path.delimiter}${configB}`;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const inputs = await discoverInputs(defaultOptions({ home, source: "all" }));
    const paths = inputs.map((input) => input.path);
    assert.equal(paths.filter((path) => path === fs.realpathSync(same)).length, 1, "same real path is deduped");
    assert.ok(paths.some((path) => path.endsWith("other/session.jsonl")));
    assert.ok(paths.some((path) => path.endsWith("desktop-project/desktop.jsonl")));
    assert.ok(paths.some((path) => path.endsWith("/.pi/agent/sessions/project/pi.jsonl")));
    assert.ok(paths.some((path) => path.endsWith("/.gemini/tmp/project/chats/session-g.jsonl")));
    assert.ok(paths.some((path) => path.endsWith("/.qwen/projects/project/chats/qwen.jsonl")));
  } finally {
    if (previousDirs === undefined) delete process.env.CLAUDE_CONFIG_DIRS;
    else process.env.CLAUDE_CONFIG_DIRS = previousDirs;
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
  }
});

test("exact Pi/Gemini/Qwen token semantics preserve model, provider, agent, and unknown mode", async () => {
  const home = tempHome();
  const pi = Path.join(home, ".pi", "agent", "sessions", "project", "pi.jsonl");
  writeJsonl(pi, [
    { type: "session", id: "pi-session", cwd: "/tmp/pi-project" },
    { type: "message", timestamp: "2026-07-26T00:00:00.000Z", message: {
      role: "assistant", model: "gpt-5.4", provider: "openai", usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4 },
    } },
  ]);
  const gemini = Path.join(home, ".gemini", "tmp", "g", "chats", "session-g.json");
  writeJsonl(gemini, []);
  fs.writeFileSync(gemini, JSON.stringify({ sessionId: "g", startTime: "2026-07-26T00:00:00.000Z", messages: [
    { id: "g-1", type: "gemini", timestamp: "2026-07-26T00:00:01.000Z", model: "gemini-test", tokens: { input: 100, cached: 30, output: 20, thoughts: 5 } },
  ] }));
  const qwen = Path.join(home, ".qwen", "projects", "q", "chats", "session.jsonl");
  writeJsonl(qwen, [{ type: "assistant", uuid: "q-1", sessionId: "q", timestamp: "2026-07-26T00:00:02.000Z", model: "qwen-test", usageMetadata: {
    promptTokenCount: 100, cachedContentTokenCount: 30, candidatesTokenCount: 20, thoughtsTokenCount: 5,
  } }]);

  const report = await buildReport(defaultOptions({ home, source: "all", progress: false }));
  const events = report._usageEvents;
  const byAgent = Object.fromEntries(events.map((event) => [event.agent, event]));
  assert.equal(byAgent.pi.provider, "openai");
  assert.equal(byAgent.pi.model, "gpt-5.4");
  assert.deepEqual(byAgent.pi.usage, { input: 100, cacheCreate5m: 4, cacheCreate30m: 0, cacheCreate1h: 0, cacheRead: 30, output: 20, reasoningOutput: 0, contextWindow: 0, inputIncludesCacheRead: false });
  assert.equal(byAgent.gemini.provider, "gemini");
  assert.equal(byAgent.gemini.usage.input, 70);
  assert.equal(byAgent.gemini.usage.cacheRead, 30);
  assert.equal(byAgent.gemini.usage.output, 25);
  assert.equal(byAgent.gemini.usage.reasoningOutput, 5);
  assert.equal(byAgent.qwen.provider, "qwen");
  assert.equal(byAgent.qwen.usage.input, 70);
  assert.equal(byAgent.qwen.usage.cacheRead, 30);
  assert.equal(byAgent.qwen.usage.output, 25);
  assert.equal(byAgent.qwen.usage.reasoningOutput, 5);
  for (const event of events) assert.equal(event.serviceMode, "unknown");
  assert.equal(report.total.requests, 3);

  const explicit = await buildReport(defaultOptions({ home, paths: [gemini], progress: false }));
  assert.equal(explicit.sessions[0].kind, "json");
  assert.equal(explicit.total.requests, 1);
});

test("malformed harness source is isolated in lenient mode and strict mode throws", async () => {
  const home = tempHome();
  const badGemini = Path.join(home, ".gemini", "tmp", "bad", "chats", "session-bad.json");
  fs.mkdirSync(Path.dirname(badGemini), { recursive: true });
  fs.writeFileSync(badGemini, "{not-json");
  const goodQwen = Path.join(home, ".qwen", "projects", "good", "chats", "session.jsonl");
  writeJsonl(goodQwen, [{ type: "assistant", uuid: "q-1", sessionId: "q", timestamp: "2026-07-26T00:00:02.000Z", model: "qwen-test", usageMetadata: {
    promptTokenCount: 5, cachedContentTokenCount: 1, candidatesTokenCount: 2, thoughtsTokenCount: 0,
  } }]);

  const lenient = await buildReport(defaultOptions({ home, source: "all", progress: false }));
  assert.equal(lenient.total.requests, 1);
  assert.ok(lenient.sources.parseErrors >= 1);
  assert.ok(lenient.sessions.some((session) => session.path === fs.realpathSync(badGemini) && session.parseErrors >= 1));
  await assert.rejects(
    () => buildReport(defaultOptions({ home, source: "all", strictJson: true, progress: false })),
    /Invalid JSON|Malformed JSON|Unexpected token/,
  );
});

test("model names do not infer fast service mode", async () => {
  const home = tempHome();
  const gemini = Path.join(home, ".gemini", "tmp", "g", "chats", "session-fast.jsonl");
  writeJsonl(gemini, [
    { sessionId: "g", startTime: "2026-07-26T00:00:00.000Z" },
    { id: "g-1", type: "gemini", timestamp: "2026-07-26T00:00:01.000Z", model: "gemini-fast", tokens: { input: 1, cached: 0, output: 1 } },
  ]);
  const report = await buildReport(defaultOptions({ home, source: "gemini", progress: false }));
  assert.equal(report._usageEvents[0].serviceMode, "unknown");
});
