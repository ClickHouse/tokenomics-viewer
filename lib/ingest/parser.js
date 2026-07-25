"use strict";

const {
  AGENT_CODEX,
  MAX_VALID_OUTPUT_CHARS_PER_TOKEN,
  UNKNOWN_EFFORT,
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
  addOutputCharTokenMetric,
  addOutputCharTokenStats,
  addToStats,
  inferProvider,
  isValidDate,
  newVisibleChars,
  outputTextTokens,
} = require("../core/report-model");
const {
  addCodexVisibleChars,
  codexAssistantOutputTextChars,
  codexTraceIds,
  effortFromCodexTurnContext,
  hasUsageTokens,
  normalizeCodexUuid,
  normalizeUsage,
  sameCodexUuid,
  usageFromClaudeUsage,
  usageFromOmpUsage,
  usageFromCodexInfo,
} = require("../core/usage");
const { addUsage } = require("../core/aggregate");
const { addRateLimitSnapshot } = require("../core/rate-limits");
const { addTelemetrySnapshot } = require("../core/telemetry");

function createLineProcessor(report, options, sourceLabel, session = null) {
  const newAssistantOutputChars = () => ({
    responseItem: 0,
    agentMessage: 0,
  });
  // Codex can mirror visible assistant text in both shapes. Prefer the
  // response_item form; use agent_message only when that is the only shape.
  const preferredAssistantOutputChars = (chars) =>
    chars.responseItem > 0 ? chars.responseItem : chars.agentMessage;

  const newTurn = (turnId, timestamp) => ({
    turnId: turnId || null,
    timestamp: isValidDate(timestamp) ? timestamp : new Date(NaN),
    project: UNKNOWN_PROJECT,
    model: UNKNOWN_MODEL,
    provider: "openai",
    effort: UNKNOWN_EFFORT,
    assistantOutputChars: newAssistantOutputChars(),
    output: 0,
    reasoningOutput: 0,
    hasOutputCharMetric: false,
    lastTokenUsageKey: null,
  });
  const codexState = {
    sessionId: null,
    forkedFromId: null,
    forkParentTraces: null,
    forkReplayBoundaryTraces: null,
    skippingForkReplay: false,
    preScannedForkReplay: false,
    preferLastTokenUsageAfterForkReplay: false,
    project: UNKNOWN_PROJECT,
    model: UNKNOWN_MODEL,
    provider: "openai",
    effort: UNKNOWN_EFFORT,
    totalUsage: null,
    visibleChars: newVisibleChars(),
    assistantOutputChars: newAssistantOutputChars(),
    turn: null,
    hasCodexMetadata: false,
  };

  const ompState = {
    hasOmpSession: false,
    project: UNKNOWN_PROJECT,
    activeModel: null,
  };

  const seenClaudeRequests = new Set();

  const updateTurnMeta = () => {
    if (!codexState.turn) return;
    codexState.turn.project = codexState.project;
    codexState.turn.model = codexState.model;
    codexState.turn.provider = codexState.provider || "openai";
    codexState.turn.effort = codexState.effort;
  };

  const flushTurn = () => {
    const turn = codexState.turn;
    if (!turn) return null;
    updateTurnMeta();
    const visibleOutputTokens = outputTextTokens(turn);
    const visibleOutputChars = preferredAssistantOutputChars(turn.assistantOutputChars);
    let event = null;
    if (!turn.hasOutputCharMetric && visibleOutputChars > 0 && visibleOutputTokens > 0) {
      event = addOutputCharTokenMetric(report, {
        sourcePath: session?.path || sourceLabel,
        turnId: turn.turnId,
        timestamp: turn.timestamp,
        provider: turn.provider,
        model: turn.model,
        project: turn.project,
        effort: turn.effort,
        visibleOutputChars,
        visibleOutputTokens,
      });
      if (session) addOutputCharTokenStats(session.stats, event);
    }
    codexState.turn = null;
    return event;
  };

  const beginForkReplay = () => {
    if (!codexState.skippingForkReplay) {
      codexState.totalUsage = null;
      codexState.visibleChars = newVisibleChars();
      codexState.assistantOutputChars = newAssistantOutputChars();
      flushTurn();
    }
    codexState.skippingForkReplay = true;
  };

  const endForkReplay = () => {
    codexState.skippingForkReplay = false;
    codexState.totalUsage = null;
    codexState.preferLastTokenUsageAfterForkReplay = true;
  };

  const ensureTurn = (turnId, timestamp) => {
    const normalizedTurnId = turnId || null;
    const timestampValue = isValidDate(timestamp) ? timestamp : new Date(NaN);
    if (codexState.turn && normalizedTurnId && codexState.turn.turnId && normalizedTurnId !== codexState.turn.turnId) {
      flushTurn();
    }
    if (!codexState.turn) {
      codexState.turn = newTurn(normalizedTurnId, timestampValue);
    } else if (!codexState.turn.turnId && normalizedTurnId) {
      codexState.turn.turnId = normalizedTurnId;
    }
    if (!isValidDate(codexState.turn.timestamp) && isValidDate(timestampValue)) {
      codexState.turn.timestamp = timestampValue;
    }
    updateTurnMeta();
  };

  const addOmpUsage = (json, lineNo) => {
    // Model id: prefer the model nested in the assistant message; fall back to
    // the model_change combined form (segment after the last '/'), else UNKNOWN.
    const bareModel = typeof json.message?.model === "string" && json.message?.model.length > 0
      ? json.message?.model
      : (ompState.activeModel ? ompState.activeModel.split("/").pop() : UNKNOWN_MODEL);
    const model = bareModel || UNKNOWN_MODEL;
    // Duplicate-timestamp gotcha (RESEARCH.md §3 gotcha 1): omp flattens the
    // entry-level ISO timestamp and the message-level Unix-ms timestamp onto
    // the SAME object under "timestamp". JSON.parse keeps the LAST (the ms
    // number). new Date(<number>) treats it as ms-epoch; new Date(<iso-string>)
    // also works. A single new Date(json.timestamp) handles both — do NOT
    // assume json.timestamp is a string.
    const timestamp = new Date(json.timestamp);
    const added = addUsage(report, {
      provider: "omp", // A3: explicit pin; inferProvider is never called
      model,
      project: ompState.project,
      effort: UNKNOWN_EFFORT, // omp has no effort concept (D4 flat)
      timestamp,
      usage: usageFromOmpUsage(json.message?.usage), // §5; ignores message.usage.cost (A5)
      sourcePath: session?.path || sourceLabel,
      lineNo,
    }, options);
    if (session) addToStats(session.stats, added.usage, added.cost);
  };

  const processor = (line, lineNo) => {
    if (!line.trim()) return;

    let json;
    try {
      json = JSON.parse(line);
    } catch {
      report.sources.parseErrors += 1;
      if (session) session.parseErrors += 1;
      if (options.strictJson) {
        throw new Error(`Invalid JSON in ${sourceLabel}:${lineNo}`);
      }
      return;
    }

    if (session) session.records += 1;

    if (
      json.type === "assistant" &&
      json.error === "rate_limit" &&
      json.message &&
      !codexState.hasCodexMetadata &&
      inferProvider(json.message.model, "anthropic") === "anthropic"
    ) {
      addTelemetrySnapshot(report, {
        sourcePath: session?.path || sourceLabel,
        lineNo,
        timestamp: new Date(json.timestamp),
        provider: "anthropic",
        agent: "claude-code",
        model: json.message?.model || UNKNOWN_MODEL,
        project: json.cwd || UNKNOWN_PROJECT,
        eventKind: "rate_limit_error",
        message: json.message?.content?.[0]?.text || null,
        rawPayload: {
          error: json.error,
          apiErrorStatus: json.apiErrorStatus ?? null,
          message: json.message?.content?.[0]?.text || null,
          version: json.version || null,
        },
      });
    }

    if (json.type === "session_meta" && json.payload) {
      codexState.hasCodexMetadata = true;
      if (!codexState.sessionId) {
        codexState.sessionId = normalizeCodexUuid(json.payload.id) || json.payload.id || null;
        codexState.forkedFromId = normalizeCodexUuid(json.payload.forked_from_id);
        codexState.forkParentTraces = codexState.forkedFromId
          ? options.codexForkRegistry?.tracesBySession?.get(codexState.forkedFromId) || null
          : null;
        codexState.forkReplayBoundaryTraces = codexState.sessionId
          ? options.codexForkRegistry?.replayBoundariesBySession?.get(codexState.sessionId) || null
          : null;
        codexState.preScannedForkReplay = Boolean(
          codexState.sessionId &&
          options.codexForkRegistry?.replaySessions?.has(normalizeCodexUuid(codexState.sessionId)),
        );
        if (codexState.preScannedForkReplay) beginForkReplay();
      } else if (
        codexState.forkedFromId &&
        sameCodexUuid(json.payload.id, codexState.forkedFromId)
      ) {
        beginForkReplay();
        return;
      }
      codexState.project = json.payload.cwd || codexState.project;
      codexState.provider = json.payload.model_provider || codexState.provider;
      codexState.model = json.payload.model || codexState.model;
      return;
    }

    if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
      addTelemetrySnapshot(report, {
        sourcePath: session?.path || sourceLabel,
        lineNo,
        timestamp: new Date(json.timestamp),
        provider: codexState.provider || "openai",
        agent: AGENT_CODEX,
        model: codexState.model,
        project: codexState.project,
        eventKind: "usage_snapshot",
        rawPayload: json.payload,
      });
    }

    const traceIds = codexTraceIds(json);
    if (codexState.forkParentTraces) {
      if (traceIds.some((traceId) => codexState.forkParentTraces.has(traceId))) {
        beginForkReplay();
        return;
      }
      if (codexState.skippingForkReplay) {
        if (traceIds.length === 0) return;
        endForkReplay();
      }
    } else if (
      codexState.skippingForkReplay &&
      codexState.forkReplayBoundaryTraces?.size > 0 &&
      traceIds.some((traceId) => codexState.forkReplayBoundaryTraces.has(traceId))
    ) {
      endForkReplay();
    }

    if (codexState.skippingForkReplay) {
      if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
        const codexUsage = usageFromCodexInfo(json.payload.info, codexState.totalUsage);
        codexState.totalUsage = codexUsage.totalUsage || null;
      }
      if (codexState.skippingForkReplay) return;
    }

    if (json.type === "event_msg" && json.payload?.type === "task_started") {
      ensureTurn(json.payload.turn_id || null, new Date(json.timestamp));
    } else if (json.type === "turn_context" && json.payload?.turn_id) {
      ensureTurn(json.payload.turn_id, new Date(json.timestamp));
    }

    const assistantOutputTextChars = codexAssistantOutputTextChars(json);
    addCodexVisibleChars(codexState.visibleChars, json);
    if (assistantOutputTextChars > 0) {
      ensureTurn(null, new Date(json.timestamp));
      const shape = json.type === "response_item" ? "responseItem" : "agentMessage";
      codexState.assistantOutputChars[shape] += assistantOutputTextChars;
      codexState.turn.assistantOutputChars[shape] += assistantOutputTextChars;
    }

    if (json.type === "turn_context" && json.payload) {
      codexState.project = json.payload.cwd || codexState.project;
      codexState.model = json.payload.model || codexState.model;
      codexState.effort = effortFromCodexTurnContext(json.payload);
      updateTurnMeta();
      return;
    }

    if (json.type === "event_msg" && json.payload?.type === "token_count" && json.payload.info) {
      report.sources.tokenCountSnapshots += 1;
      if (session) session.tokenCountSnapshots += 1;

      const timestamp = new Date(json.timestamp);
      ensureTurn(null, timestamp);
      const provider = codexState.provider || "openai";
      const model = codexState.model;
      const effort = codexState.effort;
      const lastTokenUsage = json.payload.info.last_token_usage;
      if (!json.payload.info.total_token_usage && lastTokenUsage) {
        const lastTokenUsageKey = JSON.stringify(lastTokenUsage);
        // Without an explicit turn boundary, repeated last-only snapshots may
        // be distinct requests in older logs, so leave those streams intact.
        if (codexState.turn.turnId && codexState.turn.lastTokenUsageKey === lastTokenUsageKey) {
          addRateLimitSnapshot(report, json.payload.rate_limits, {
            agent: AGENT_CODEX,
            provider,
            model,
            effort,
            timestamp,
            sourcePath: session?.path || sourceLabel,
            lineNo,
            usage: normalizeUsage({}),
            cost: { known: true, amount: 0, reasoningAmount: 0 },
          });
          report.sources.skippedTokenCountSnapshots += 1;
          if (session) session.skippedTokenCountSnapshots += 1;
          return;
        }
        codexState.turn.lastTokenUsageKey = codexState.turn.turnId ? lastTokenUsageKey : null;
      } else {
        codexState.turn.lastTokenUsageKey = null;
      }
      const codexUsage = usageFromCodexInfo(
        json.payload.info,
        codexState.totalUsage,
        codexState.preferLastTokenUsageAfterForkReplay,
      );
      codexState.totalUsage = codexUsage.totalUsage || null;
      codexState.preferLastTokenUsageAfterForkReplay = false;
      codexState.turn.output += codexUsage.usage.output;
      codexState.turn.reasoningOutput += codexUsage.usage.reasoningOutput;

      if (!hasUsageTokens(codexUsage.usage)) {
        addRateLimitSnapshot(report, json.payload.rate_limits, {
          agent: AGENT_CODEX,
          provider,
          model,
          effort,
          timestamp,
          sourcePath: session?.path || sourceLabel,
          lineNo,
          usage: normalizeUsage(codexUsage.usage),
          cost: { known: true, amount: 0, reasoningAmount: 0 },
        });
        report.sources.skippedTokenCountSnapshots += 1;
        if (session) session.skippedTokenCountSnapshots += 1;
        return;
      }

      const added = addUsage(report, {
        provider,
        model,
        project: codexState.project,
        effort,
        timestamp,
        usage: codexUsage.usage,
        visibleChars: codexState.visibleChars,
        sourcePath: session?.path || sourceLabel,
        lineNo,
      }, options);
      const visibleOutputTokens = outputTextTokens(added.usage);
      const visibleOutputChars = preferredAssistantOutputChars(codexState.assistantOutputChars);
      if (visibleOutputChars > 0 && visibleOutputTokens > 0) {
        const charsPerToken = visibleOutputChars / visibleOutputTokens;
        codexState.turn.hasOutputCharMetric = true;
        if (charsPerToken <= MAX_VALID_OUTPUT_CHARS_PER_TOKEN) {
          const outputCharMetric = addOutputCharTokenMetric(report, {
            sourcePath: session?.path || sourceLabel,
            turnId: codexState.turn?.turnId || null,
            timestamp,
            provider,
            model,
            project: codexState.project,
            effort,
            visibleOutputChars,
            visibleOutputTokens,
          });
          if (session) addOutputCharTokenStats(session.stats, outputCharMetric);
        }
      }
      codexState.visibleChars = newVisibleChars();
      codexState.assistantOutputChars = newAssistantOutputChars();
      addRateLimitSnapshot(report, json.payload.rate_limits, {
        agent: AGENT_CODEX,
        provider,
        model,
        effort,
        timestamp,
        sourcePath: session?.path || sourceLabel,
        lineNo,
        usage: added.usage,
        cost: added.cost,
      });
      if (session) addToStats(session.stats, added.usage, added.cost, added.visibleChars);
      return;
    }

    if (json.type === "session" && json.id) {
      ompState.hasOmpSession = true;
      ompState.project = json.cwd || ompState.project;
      return;
    }

    if (json.type === "model_change" && typeof json.model === "string") {
      ompState.activeModel = json.model;
      return;
    }

    if (json.type === "message" && json.message?.role === "assistant" && json.message?.usage) {
      addOmpUsage(json, lineNo);
      return;
    }

    if (json.type === "message" && json.message?.role === "toolResult" && json.message?.usage) {
      addOmpUsage(json, lineNo);
      return;
    }

    if (json.type === "assistant" && json.message?.usage) {
      const requestKey = json.requestId || json.uuid;
      const model = json.message.model || UNKNOWN_MODEL;
      if (json.error !== "rate_limit") {
        addTelemetrySnapshot(report, {
          sourcePath: session?.path || sourceLabel,
          lineNo,
          timestamp: new Date(json.timestamp),
          provider: inferProvider(model, "anthropic"),
          agent: "claude-code",
          model,
          project: json.cwd || UNKNOWN_PROJECT,
          eventKind: "usage_snapshot",
          rawPayload: json.message.usage,
        });
      }
      if (requestKey && seenClaudeRequests.has(requestKey)) return;
      if (requestKey) seenClaudeRequests.add(requestKey);
      if (json.error === "rate_limit") return;
      const added = addUsage(report, {
        provider: inferProvider(model, "anthropic"),
        model,
        project: json.cwd || UNKNOWN_PROJECT,
        effort: UNKNOWN_EFFORT,
        timestamp: new Date(json.timestamp),
        usage: usageFromClaudeUsage(json.message.usage),
        sourcePath: session?.path || sourceLabel,
        lineNo,
      }, options);
      if (session) addToStats(session.stats, added.usage, added.cost);
    }
  };
  if (typeof report._afterLine === "function") processor.afterLine = report._afterLine;
  processor.finalize = () => {
    flushTurn();
    return typeof processor.afterLine === "function" ? processor.afterLine() : null;
  };
  return processor;
}

module.exports = {
  createLineProcessor,
};
