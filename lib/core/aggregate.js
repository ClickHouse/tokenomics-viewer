"use strict";

const {
  UNKNOWN_MODEL,
  UNKNOWN_PROJECT,
  addToStats,
  bucket,
  dateKey,
  inferProvider,
  isValidDate,
  monthKey,
  nestedBucket,
  normalizeEffort,
  normalizeVisibleChars,
  providerModelEffortDailyBucket,
  quarterHourKey,
  weekKey,
  yearKey,
} = require("./report-model");
const { normalizeUsage } = require("./usage");
const { calculateCost, normalizeServiceTier } = require("./pricing");
const { normalizeAgent, normalizeServiceMode } = require("./service-mode");

function addUsage(report, record, options) {
  const timestamp = isValidDate(record.timestamp) ? record.timestamp : new Date(NaN);
  const project = record.project || UNKNOWN_PROJECT;
  const model = record.model || UNKNOWN_MODEL;
  const provider = record.provider || inferProvider(model);
  const effort = normalizeEffort(record.effort);
  const serviceTier = normalizeServiceTier(record.serviceTier);
  const serviceMode = normalizeServiceMode(record.serviceMode);
  const agent = normalizeAgent(record.agent, provider);
  const usage = normalizeUsage(record.usage);
  const cost = calculateCost(provider, model, usage, timestamp, { ...options, serviceTier, serviceMode });
  const visibleChars = normalizeVisibleChars(record.visibleChars, usage);

  addToStats(report.total, usage, cost, visibleChars);
  const quarterHour = quarterHourKey(timestamp);
  if (quarterHour) {
    addToStats(bucket(report.quarterHourly, quarterHour), usage, cost, visibleChars);
    addToStats(nestedBucket(report.projectQuarterHourly, project, quarterHour), usage, cost, visibleChars);
    report.quarterHourlyProviderModels[quarterHour] ??= {};
    addToStats(nestedBucket(report.quarterHourlyProviderModels[quarterHour], provider, model), usage, cost, visibleChars);
    report.projectQuarterHourlyProviderModels[project] ??= {};
    report.projectQuarterHourlyProviderModels[project][quarterHour] ??= {};
    addToStats(nestedBucket(report.projectQuarterHourlyProviderModels[project][quarterHour], provider, model), usage, cost, visibleChars);
  }
  addToStats(bucket(report.daily, dateKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.weekly, weekKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.monthly, monthKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.yearly, yearKey(timestamp)), usage, cost, visibleChars);
  addToStats(bucket(report.providers, provider), usage, cost, visibleChars);
  addToStats(bucket(report.models, model), usage, cost, visibleChars);
  addToStats(bucket(report.providerModels, `${provider}/${model}`), usage, cost, visibleChars);
  addToStats(bucket(report.serviceTiers, serviceTier), usage, cost, visibleChars);
  addToStats(bucket(report.serviceModes, serviceMode), usage, cost, visibleChars);
  addToStats(bucket(report.agents, agent), usage, cost, visibleChars);
  addToStats(bucket(report.projects, project), usage, cost, visibleChars);
  addToStats(nestedBucket(report.projectDaily, project, dateKey(timestamp)), usage, cost, visibleChars);
  addToStats(nestedBucket(report.projectModels, project, model), usage, cost, visibleChars);
  report.projectProviderModels[project] ??= {};
  addToStats(nestedBucket(report.projectProviderModels[project], provider, model), usage, cost, visibleChars);
  addToStats(bucket(report.efforts, effort), usage, cost, visibleChars);
  addToStats(nestedBucket(report.modelEfforts, model, effort), usage, cost, visibleChars);
  addToStats(providerModelEffortDailyBucket(report, provider, model, effort, dateKey(timestamp)), usage, cost, visibleChars);

  if (!cost.known) {
    const key = `${provider}/${model}`;
    report.unpricedModels[key] ??= { provider, model, requests: 0 };
    report.unpricedModels[key].requests += 1;
  }

  const event = {
    sourcePath: record.sourcePath || null,
    lineNo: Number.isFinite(record.lineNo) ? record.lineNo : null,
    timestamp: isValidDate(timestamp) ? timestamp.toISOString() : null,
    provider,
    model,
    project,
    effort,
    serviceTier,
    serviceMode,
    agent,
    usage,
    cost: {
      known: cost.known,
      amount: cost.amount,
      reasoningAmount: cost.reasoningAmount,
      breakdown: cost.breakdown,
    },
    visibleChars,
  };
  if (typeof report._usageEventSink === "function") {
    report._usageEventSink(event);
  } else {
    report._usageEvents.push(event);
  }

  return { timestamp, project, model, provider, effort, serviceTier, serviceMode, agent, usage, cost, visibleChars };
}

module.exports = {
  addUsage,
};
