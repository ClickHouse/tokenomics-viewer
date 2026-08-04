#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const Path = require("node:path");
const { webSummary } = require("../lib/dashboard");
const { newReport, newStats } = require("../lib/core/report-model");

const fixtureDirectory = Path.resolve(__dirname, "../mac/Tests/TokenomicsMenubarTests/Fixtures");
const fixturePath = Path.join(fixtureDirectory, "summary-v1.json");
const subscriptionFixturePath = Path.join(fixtureDirectory, "summary-v1-subscription.json");

function buildMacOSSummaryFixture() {
  const report = newReport();
  report.monthlyCostLimitUsd = 100;
  report.total.costUsd = 34.5;
  report.monthly["2026-08"] = { costUsd: 34.5 };
  report.daily["2026-08-01"] = { costUsd: 30 };
  report.daily["2026-08-03"] = { costUsd: 4.5 };

  return webSummary(report, {
    now: new Date("2026-08-03T12:00:00.000Z"),
    top: 25,
  });
}

function buildMacOSSubscriptionSummaryFixture() {
  const report = newReport();
  report.usageProfile = { id: "pro", name: "ChatGPT Pro", mode: "subscription" };
  report.total.costUsd = 18.42;
  report.total.requests = 8;
  report.total.pricedRequests = 8;
  report.monthly["2026-08"] = { costUsd: 18.42 };
  report.daily["2026-08-03"] = { costUsd: 18.42 };

  const latestAt = "2026-08-03T12:00:00.000Z";
  report.rateLimits.windows["codex/codex:primary_300m"] = {
    agent: "codex",
    limitId: "codex",
    kind: "primary",
    windowMinutes: 300,
    planType: "pro",
    samples: 8,
    latestUsedPercent: 68,
    latestRemainingPercent: 32,
    latestAt,
    latestResetAt: Date.parse("2026-08-03T13:24:00.000Z") / 1_000,
  };
  report.rateLimits.windows["codex/codex:secondary_10080m"] = {
    agent: "codex",
    limitId: "codex",
    kind: "secondary",
    windowMinutes: 10_080,
    planType: "pro",
    samples: 8,
    latestUsedPercent: 41,
    latestRemainingPercent: 59,
    latestAt,
    latestResetAt: Date.parse("2026-08-10T12:00:00.000Z") / 1_000,
  };
  report.rateLimits.planHistory = [
    { date: "2026-08-03", agent: "codex", limitId: "codex", planType: "pro", samples: 8 },
  ];

  const period = "2026-08-03T11:45Z";
  const modelStats = newStats();
  Object.assign(modelStats, {
    requests: 8,
    pricedRequests: 8,
    input: 1_000,
    cacheRead: 2_000,
    output: 300,
    costUsd: 18.42,
  });
  report.quarterHourly[period] = modelStats;
  report.quarterHourlyProviderModels[period] = {
    openai: { "gpt-5.6-sol": modelStats },
  };

  return webSummary(report, {
    now: new Date(latestAt),
    top: 25,
  });
}

function writeMacOSSummaryFixture() {
  fs.mkdirSync(fixtureDirectory, { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(buildMacOSSummaryFixture(), null, 2)}\n`);
  fs.writeFileSync(subscriptionFixturePath, `${JSON.stringify(buildMacOSSubscriptionSummaryFixture(), null, 2)}\n`);
}

if (require.main === module) writeMacOSSummaryFixture();

module.exports = {
  buildMacOSSummaryFixture,
  buildMacOSSubscriptionSummaryFixture,
  fixturePath,
  subscriptionFixturePath,
  writeMacOSSummaryFixture,
};
