"use strict";

const {
  normalizeEffort,
  number,
} = require("./report-model");

function normalizeUsage(usage) {
  const source = usage || {};
  const cacheRead = number(source.cacheRead);
  const rawInput = number(source.input);
  const inputIncludesCacheRead = source.inputIncludesCacheRead !== false;
  const input = inputIncludesCacheRead ? Math.max(0, rawInput - cacheRead) : rawInput;
  const output = number(source.output);
  const reasoningOutput = Math.min(number(source.reasoningOutput), output);
  return {
    input,
    cacheCreate5m: number(source.cacheCreate5m),
    cacheCreate30m: number(source.cacheCreate30m),
    cacheCreate1h: number(source.cacheCreate1h),
    cacheRead,
    output,
    reasoningOutput,
    contextWindow: number(source.contextWindow),
    inputIncludesCacheRead: false,
  };
}

function usageFromCodexTokenUsage(tokenUsage, contextWindow) {
  const source = tokenUsage || {};
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(source, key);
  const nestedDetails = source.input_tokens_details ?? source.prompt_tokens_details;
  const hasOfficialNestedDetails = Boolean(
    nestedDetails &&
    typeof nestedDetails === "object" &&
    (Object.prototype.hasOwnProperty.call(nestedDetails, "cached_tokens") ||
      Object.prototype.hasOwnProperty.call(nestedDetails, "cache_write_tokens")),
  );
  const details = hasOfficialNestedDetails ? nestedDetails : {};
  const cacheCreation = source.cache_creation || source.cacheCreation || {};
  const hasExplicitCacheFormat = hasOwn("cache_creation_input_tokens") ||
    hasOwn("cache_write_input_tokens") ||
    hasOwn("cache_create_input_tokens") ||
    hasOwn("cache_read_input_tokens") ||
    hasOwn("cache_creation") ||
    hasOwn("cacheCreation");
  const cacheCreate30m = hasOfficialNestedDetails
    ? number(details.cache_write_tokens)
    : number(
      source.cache_creation_input_tokens ??
      source.cache_write_input_tokens ??
      source.cache_create_input_tokens ??
      cacheCreation.ephemeral_30m_input_tokens ??
      cacheCreation.thirty_minute_input_tokens,
    );
  const cacheRead = hasOfficialNestedDetails
    ? number(details.cached_tokens)
    : number(source.cache_read_input_tokens ?? source.cached_input_tokens);
  const rawInput = number(source.input_tokens ?? source.prompt_tokens);
  const output = number(source.output_tokens);
  const reportedTotal = number(source.total_tokens);
  const totalShowsInputIncludesCache = hasOwn("total_tokens") && reportedTotal === rawInput + output;
  return {
    input: hasOfficialNestedDetails || totalShowsInputIncludesCache
      ? Math.max(0, rawInput - cacheRead - cacheCreate30m)
      : hasExplicitCacheFormat
        ? rawInput
        : Math.max(0, rawInput - cacheRead),
    inputCounter: rawInput,
    cacheCreate5m: 0,
    cacheCreate30m,
    cacheCreate1h: 0,
    cacheRead,
    output,
    reasoningOutput: number(source.reasoning_output_tokens),
    contextWindow,
    inputIncludesCacheRead: false,
  };
}

function subtractUsage(current, previous) {
  if (
    current.inputCounter < previous.inputCounter ||
    current.cacheCreate5m < previous.cacheCreate5m ||
    current.cacheCreate30m < previous.cacheCreate30m ||
    current.cacheCreate1h < previous.cacheCreate1h ||
    current.cacheRead < previous.cacheRead ||
    current.output < previous.output ||
    current.reasoningOutput < previous.reasoningOutput
  ) {
    return { ...current, sequenceReset: true };
  }

  return {
    input: Math.max(0, current.input - previous.input),
    inputCounter: Math.max(0, current.inputCounter - previous.inputCounter),
    cacheCreate5m: 0,
    cacheCreate30m: Math.max(0, current.cacheCreate30m - previous.cacheCreate30m),
    cacheCreate1h: 0,
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    output: Math.max(0, current.output - previous.output),
    reasoningOutput: Math.max(0, current.reasoningOutput - previous.reasoningOutput),
    contextWindow: current.contextWindow,
    inputIncludesCacheRead: current.inputIncludesCacheRead,
  };
}

function hasUsageTokens(usage) {
  return (
    usage.input > 0 ||
    usage.cacheCreate5m > 0 ||
    usage.cacheCreate30m > 0 ||
    usage.cacheCreate1h > 0 ||
    usage.cacheRead > 0 ||
    usage.output > 0 ||
    usage.reasoningOutput > 0
  );
}

function usageFromCodexInfo(info, previousTotalUsage = null, preferLastTokenUsage = false) {
  const source = info || {};
  const contextWindow = number(source.model_context_window);
  if (source.total_token_usage) {
    const totalUsage = usageFromCodexTokenUsage(source.total_token_usage, contextWindow);
    const lastUsage = source.last_token_usage
      ? usageFromCodexTokenUsage(source.last_token_usage, contextWindow)
      : null;
    const usage = preferLastTokenUsage && lastUsage
      ? lastUsage
      : previousTotalUsage ? subtractUsage(totalUsage, previousTotalUsage) : totalUsage;
    return {
      usage,
      totalUsage,
    };
  }

  const last = source.last_token_usage || source;
  return {
    usage: usageFromCodexTokenUsage(last, contextWindow),
    totalUsage: null,
  };
}

function usageFromClaudeUsage(usage) {
  const source = usage || {};
  const cacheCreation = source.cache_creation || {};
  const cacheCreate5m = number(cacheCreation.ephemeral_5m_input_tokens);
  const cacheCreate1h = number(cacheCreation.ephemeral_1h_input_tokens);
  const totalCacheCreate = number(source.cache_creation_input_tokens);
  const outputDetails = source.output_tokens_details || source.output_token_details || source.output_details || {};

  return {
    input: number(source.input_tokens),
    cacheCreate5m,
    cacheCreate30m: 0,
    cacheCreate1h: cacheCreate1h || Math.max(0, totalCacheCreate - cacheCreate5m),
    cacheRead: number(source.cache_read_input_tokens),
    output: number(source.output_tokens),
    reasoningOutput: number(outputDetails.thinking_tokens || source.thinking_tokens),
    contextWindow: 0,
    inputIncludesCacheRead: false,
  };
}

function usageFromOmpUsage(usage) {
  const source = usage || {};
  return {
    input: number(source.input),
    cacheCreate5m: number(source.cacheWrite), // §5.3: omp's single cacheWrite bucket → 5m
    cacheCreate30m: 0,
    cacheCreate1h: 0,
    cacheRead: number(source.cacheRead),
    output: number(source.output),
    reasoningOutput: 0,
    contextWindow: 0,
    inputIncludesCacheRead: false, // §5.2: omp usage.input is non-cached (verified: totalTokens = input+output+cacheRead+cacheWrite)
  };
}

function effortFromCodexTurnContext(payload) {
  return normalizeEffort(
    payload?.effort ||
    payload?.collaboration_mode?.settings?.reasoning_effort
  );
}

function visibleTextChars(value, depth = 0) {
  if (depth > 4 || value == null) return 0;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + visibleTextChars(item, depth + 1), 0);
  if (typeof value !== "object") return 0;
  if (typeof value.text === "string") return value.text.length;
  if (typeof value.output_text === "string") return value.output_text.length;
  if (typeof value.input_text === "string") return value.input_text.length;
  if (value.content !== undefined) return visibleTextChars(value.content, depth + 1);
  return 0;
}

function addVisibleChars(target, kind, chars) {
  if (!chars) return;
  if (kind === "output") target.output += chars;
  else target.input += chars;
}

function addCodexVisibleChars(target, json) {
  if (json.type === "event_msg") {
    const payload = json.payload || {};
    if (payload.type === "user_message") addVisibleChars(target, "input", visibleTextChars(payload.message));
    else if (payload.type === "agent_message") addVisibleChars(target, "output", visibleTextChars(payload.message));
    return;
  }

  if (json.type !== "response_item") return;
  const payload = json.payload || {};
  if (payload.type === "message") {
    const role = payload.role || "assistant";
    const kind = role === "assistant" ? "output" : "input";
    addVisibleChars(target, kind, visibleTextChars(payload.content));
  } else if (payload.type === "function_call") {
    addVisibleChars(target, "output", visibleTextChars(payload.arguments));
  } else if (payload.type === "function_call_output") {
    addVisibleChars(target, "input", visibleTextChars(payload.output));
  }
}

function codexAssistantOutputTextChars(json) {
  // agent_message is the fallback for logs that do not contain response_item
  // assistant text; the parser prefers response_item when both are present.
  if (json.type === "event_msg") {
    const payload = json.payload || {};
    if (payload.type === "agent_message") return visibleTextChars(payload.message);
    return 0;
  }
  if (json.type !== "response_item") return 0;
  const payload = json.payload || {};
  if (payload.type !== "message") return 0;
  if ((payload.role || "assistant") !== "assistant") return 0;
  return visibleTextChars(payload.content);
}

const CODEX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeCodexUuid(value) {
  if (typeof value !== "string") return null;
  return CODEX_UUID_RE.test(value) ? value.toLowerCase() : null;
}

function sameCodexUuid(left, right) {
  const normalizedLeft = normalizeCodexUuid(left);
  const normalizedRight = normalizeCodexUuid(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function codexTraceIds(json) {
  const payload = json?.payload || {};
  const ids = [];
  if (typeof payload.turn_id === "string" && payload.turn_id) ids.push(`turn:${payload.turn_id}`);
  if (typeof payload.call_id === "string" && payload.call_id) ids.push(`call:${payload.call_id}`);
  return ids;
}

module.exports = {
  addCodexVisibleChars,
  addVisibleChars,
  codexAssistantOutputTextChars,
  codexTraceIds,
  effortFromCodexTurnContext,
  hasUsageTokens,
  normalizeCodexUuid,
  normalizeEffort,
  normalizeUsage,
  sameCodexUuid,
  subtractUsage,
  usageFromClaudeUsage,
  usageFromOmpUsage,
  usageFromCodexInfo,
  usageFromCodexTokenUsage,
  visibleTextChars,
};
