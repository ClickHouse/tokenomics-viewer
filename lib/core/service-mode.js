"use strict";

const UNKNOWN_SERVICE_MODE = "unknown";
const STANDARD_SERVICE_MODE = "standard";
const FAST_SERVICE_MODE = "fast";

const UNKNOWN_AGENT = "unknown";
const CODEX_AGENT = "codex";
const CLAUDE_CODE_AGENT = "claude-code";
const OMP_AGENT = "omp";
const PI_AGENT = "pi";
const GEMINI_AGENT = "gemini";
const QWEN_AGENT = "qwen";
const OPENCODE_AGENT = "opencode";

function normalized(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function serviceModeFromClaudeSpeed(value) {
  const speed = normalized(value);
  if (speed === "fast") return FAST_SERVICE_MODE;
  if (speed === "standard" || speed === "normal") return STANDARD_SERVICE_MODE;
  return UNKNOWN_SERVICE_MODE;
}

function serviceModeFromCodexTier(value) {
  const tier = normalized(value);
  if (tier === "priority" || tier === "fast") return FAST_SERVICE_MODE;
  if (tier === "default" || tier === "standard" || tier === "normal") return STANDARD_SERVICE_MODE;
  return UNKNOWN_SERVICE_MODE;
}

function normalizeServiceMode(value) {
  const mode = normalized(value);
  if (mode === FAST_SERVICE_MODE) return FAST_SERVICE_MODE;
  if (mode === STANDARD_SERVICE_MODE || mode === "normal") return STANDARD_SERVICE_MODE;
  return UNKNOWN_SERVICE_MODE;
}

function agentFromProvider(provider) {
  const normalizedProvider = normalized(provider);
  if (normalizedProvider === "openai") return CODEX_AGENT;
  if (normalizedProvider === "anthropic") return CLAUDE_CODE_AGENT;
  if (normalizedProvider === "omp") return OMP_AGENT;
  if (normalizedProvider === "pi") return PI_AGENT;
  if (normalizedProvider === "gemini") return GEMINI_AGENT;
  if (normalizedProvider === "qwen") return QWEN_AGENT;
  if (normalizedProvider === "opencode") return OPENCODE_AGENT;
  return UNKNOWN_AGENT;
}

function normalizeAgent(value, provider) {
  const agent = normalized(value);
  if (!agent) return agentFromProvider(provider);
  if (agent === UNKNOWN_AGENT) return UNKNOWN_AGENT;
  if (/^[a-z][a-z0-9_-]{0,63}$/.test(agent)) return agent;
  return UNKNOWN_AGENT;
}

module.exports = {
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
  normalizeServiceMode,
  serviceModeFromClaudeSpeed,
  serviceModeFromCodexTier,
};
