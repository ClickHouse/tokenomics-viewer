"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CLAUDE_CODE_AGENT,
  CODEX_AGENT,
  FAST_SERVICE_MODE,
  GEMINI_AGENT,
  OPENCODE_AGENT,
  OMP_AGENT,
  PI_AGENT,
  QWEN_AGENT,
  STANDARD_SERVICE_MODE,
  UNKNOWN_AGENT,
  UNKNOWN_SERVICE_MODE,
  agentFromProvider,
  normalizeAgent,
  serviceModeFromClaudeSpeed,
  serviceModeFromCodexTier,
} = require("../lib/core/service-mode");

test("Claude speed metadata maps fast, standard, and normal without guessing", () => {
  assert.equal(serviceModeFromClaudeSpeed("fast"), FAST_SERVICE_MODE);
  assert.equal(serviceModeFromClaudeSpeed("standard"), STANDARD_SERVICE_MODE);
  assert.equal(serviceModeFromClaudeSpeed("normal"), STANDARD_SERVICE_MODE);
  assert.equal(serviceModeFromClaudeSpeed(undefined), UNKNOWN_SERVICE_MODE);
  assert.equal(serviceModeFromClaudeSpeed("turbo"), UNKNOWN_SERVICE_MODE);
});

test("Codex service tiers map to analytics mode while preserving unknown values", () => {
  assert.equal(serviceModeFromCodexTier("priority"), FAST_SERVICE_MODE);
  assert.equal(serviceModeFromCodexTier("default"), STANDARD_SERVICE_MODE);
  assert.equal(serviceModeFromCodexTier("standard"), STANDARD_SERVICE_MODE);
  assert.equal(serviceModeFromCodexTier(undefined), UNKNOWN_SERVICE_MODE);
  assert.equal(serviceModeFromCodexTier("future-tier"), UNKNOWN_SERVICE_MODE);
});

test("agent normalization preserves supported harness dimensions and explicit slugs", () => {
  assert.equal(agentFromProvider("openai"), CODEX_AGENT);
  assert.equal(agentFromProvider("anthropic"), CLAUDE_CODE_AGENT);
  assert.equal(agentFromProvider("omp"), OMP_AGENT);
  assert.equal(agentFromProvider("pi"), PI_AGENT);
  assert.equal(agentFromProvider("gemini"), GEMINI_AGENT);
  assert.equal(agentFromProvider("qwen"), QWEN_AGENT);
  assert.equal(agentFromProvider("opencode"), OPENCODE_AGENT);
  assert.equal(agentFromProvider("future-provider"), UNKNOWN_AGENT);

  assert.equal(normalizeAgent(undefined, "openai"), CODEX_AGENT);
  assert.equal(normalizeAgent(" Custom-Harness ", "openai"), "custom-harness");
  assert.equal(normalizeAgent("unknown", "openai"), UNKNOWN_AGENT);
  assert.equal(normalizeAgent("not a slug", "openai"), UNKNOWN_AGENT);
});
