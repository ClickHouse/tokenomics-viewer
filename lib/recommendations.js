"use strict";

const MAX_RECOMMENDATIONS = 5;

function number(value) {
  return Number.isFinite(value) ? value : 0;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function roundedMoney(value) {
  return Math.round(value * 100) / 100;
}

function weeklyCostSpike(report) {
  if (number(report.total?.requests) < 100) return null;
  const costsByDay = new Map(Object.entries(report.daily || {}).filter(([day]) => /^\d{4}-\d{2}-\d{2}$/.test(day)));
  const latestDay = [...costsByDay.keys()].sort().at(-1);
  const latestTime = Date.parse(`${latestDay || ""}T00:00:00Z`);
  if (!Number.isFinite(latestTime)) return null;
  const costs = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const day = new Date(latestTime - offset * 86_400_000).toISOString().slice(0, 10);
    costs.push(number(costsByDay.get(day)?.costUsd));
  }
  const previous = costs.slice(0, 7).reduce((sum, value) => sum + value, 0);
  const current = costs.slice(7).reduce((sum, value) => sum + value, 0);
  const increase = current - previous;
  const increaseShare = previous > 0 ? increase / previous : 0;
  if (previous < 5 || increase < 10 || increaseShare < 0.25) return null;
  return {
    id: "weekly-cost-spike",
    severity: "warning",
    title: "Investigate the weekly cost increase",
    finding: `The latest 7 days cost ${percent(increaseShare)} more than the previous 7 days.`,
    action: "Compare the latest project and model mix with the previous week, then inspect the largest daily increases.",
    impactUsd: roundedMoney(increase),
    confidence: "high",
    evidence: `Latest 7 days vs previous 7 days · $${current.toFixed(2)} vs $${previous.toFixed(2)}`,
    caveat: "A cost increase does not prove inefficiency; it may reflect more work or a different workload.",
  };
}

function unpricedUsage(report) {
  const requests = number(report.total?.requests);
  const unpriced = number(report.total?.unpricedRequests);
  const share = requests > 0 ? unpriced / requests : 0;
  if (requests < 100 || unpriced === 0 || (share < 0.01 && unpriced < 100)) return null;
  const models = Object.values(report.unpricedModels || {})
    .sort((a, b) => number(b.requests) - number(a.requests))
    .map((row) => row.model)
    .filter((model) => model && !/^<.*>$/.test(model))
    .slice(0, 3);
  return {
    id: "unpriced-usage",
    severity: "warning",
    title: "Resolve unpriced usage",
    finding: `${Math.round(unpriced).toLocaleString("en-US")} requests (${percent(share)}) have no matching price.`,
    action: models.length
      ? `Classify as non-billable or add and verify pricing for: ${models.join(", ")}.`
      : "Classify the unrecognized provider/model identifiers as non-billable or add their tariffs.",
    impactUsd: null,
    confidence: "high",
    evidence: `All imported requests · ${Math.round(requests).toLocaleString("en-US")} request sample`,
    caveat: "Total cost may be understated, but subscription or intentionally non-billable requests may correctly have no API tariff.",
  };
}

function projectCostConcentration(report) {
  const totalCost = number(report.total?.costUsd);
  if (totalCost < 50) return null;
  const [projectName, stats] = Object.entries(report.projects || {})
    .filter(([name]) => !/^\(?unknown/i.test(name) && !/^<.*>$/.test(name))
    .sort((a, b) => number(b[1].costUsd) - number(a[1].costUsd))[0] || [];
  const projectCost = number(stats?.costUsd);
  const share = totalCost > 0 ? projectCost / totalCost : 0;
  if (!projectName || number(stats?.requests) < 100 || share < 0.5) return null;
  return {
    id: "project-cost-concentration",
    severity: "info",
    title: "Add a budget guard for the leading project",
    finding: `${projectName} accounts for ${percent(share)} of estimated cost.`,
    action: `Set a daily or weekly budget alert for ${projectName} and review its model mix when the threshold is crossed.`,
    impactUsd: null,
    confidence: "high",
    evidence: `$${projectCost.toFixed(2)} of $${totalCost.toFixed(2)} · ${Math.round(number(stats.requests)).toLocaleString("en-US")} requests`,
    caveat: "Cost concentration is not itself a problem when the project legitimately carries most of the workload.",
  };
}

function ingestionErrors(report) {
  const requests = number(report.total?.requests);
  const errors = number(report.sources?.parseErrors);
  const observed = Math.max(requests, number(report.sources?.tokenCountSnapshots)) + errors;
  if (requests < 1_000 || errors < 100 || errors / observed < 0.01) return null;
  return {
    id: "ingestion-parse-errors",
    severity: "warning",
    title: "Review ingestion parse errors",
    finding: `${Math.round(errors).toLocaleString("en-US")} records could not be parsed.`,
    action: "Inspect representative malformed records and verify whether their token usage is missing from the report.",
    impactUsd: null,
    confidence: "high",
    evidence: `${Math.round(errors).toLocaleString("en-US")} parse errors across ${Math.round(requests).toLocaleString("en-US")} imported requests`,
    caveat: "A parse error does not necessarily contain billable usage, so its cost impact is unknown.",
  };
}

function subscriptionQuotaPressure(context = {}) {
  if (context.usageProfile?.mode !== "subscription") return [];
  return (context.subscriptionWindows || [])
    .filter((window) => number(window.usedPercent) >= 70)
    .sort((a, b) => number(b.usedPercent) - number(a.usedPercent))
    .map((window) => {
      const minutes = number(window.windowMinutes);
      const label = minutes === 300 ? "5-hour" : (minutes === 10080 ? "weekly" : `${minutes}-minute`);
      const coverage = window.pricingCoverage == null ? null : number(window.pricingCoverage);
      const confidence = coverage !== null && coverage >= 0.95 ? "medium" : "low";
      return {
        id: `subscription-quota-pressure-${minutes}`,
        severity: number(window.usedPercent) >= 90 ? "warning" : "info",
        title: `Preserve the ${label} subscription quota`,
        finding: `The ${label} quota is ${number(window.usedPercent).toFixed(0)}% used with ${number(window.remainingPercent).toFixed(0)}% remaining.`,
        action: "Prefer Luna for suitable delegated execution and retain Sol review, then compare complete root-workflow quota and API-equivalent cost before standardizing the route.",
        impactUsd: null,
        confidence,
        evidence: `${window.apiEquivalentCostUsd == null ? "Unknown" : `$${number(window.apiEquivalentCostUsd).toFixed(2)}`} API equivalent in the observed window${coverage === null ? "" : ` · ${percent(coverage)} priced`}`,
        caveat: "This does not prove per-model quota savings or equal task quality because provider observations are rounded and may mix models.",
      };
    });
}

function apiMonthlyBudgetForecast(report, context = {}) {
  if (context.usageProfile?.mode !== "api") return null;
  const limit = number(report.monthlyCostLimitUsd);
  const now = context.now instanceof Date && Number.isFinite(context.now.getTime()) ? context.now : new Date();
  if (limit <= 0) return null;
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const cost = number(report.monthly?.[month]?.costUsd);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const elapsedDays = Math.max(0.25, now.getDate() - 1 + (now.getHours() + now.getMinutes() / 60) / 24);
  const projected = cost * daysInMonth / elapsedDays;
  const overage = projected - limit;
  if (cost < 10 || overage < Math.max(10, limit * 0.1)) return null;
  return {
    id: "api-monthly-budget-forecast",
    severity: "warning",
    title: "Reduce the projected API budget overrun",
    finding: `Projected month-end API cost is $${projected.toFixed(2)} against a $${limit.toFixed(2)} limit.`,
    action: "Review the highest-cost projects and compare complete Luna-plus-Sol-review workflows with Sol-direct work before changing routing defaults.",
    impactUsd: roundedMoney(overage),
    confidence: "medium",
    evidence: `${`$${cost.toFixed(2)}`} month to date · day ${now.getDate()} of ${daysInMonth}`,
    caveat: "The forecast assumes the current run rate continues and may move with workload or incomplete pricing coverage.",
  };
}

function buildRecommendations(report = {}, context = {}) {
  return [
    ...subscriptionQuotaPressure(context),
    apiMonthlyBudgetForecast(report, context),
    weeklyCostSpike(report),
    unpricedUsage(report),
    projectCostConcentration(report),
    ingestionErrors(report),
  ].filter(Boolean).slice(0, MAX_RECOMMENDATIONS);
}

module.exports = { buildRecommendations };
