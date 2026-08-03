#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const Path = require("node:path");
const { webSummary } = require("../lib/dashboard");
const { newReport } = require("../lib/core/report-model");

const fixturePath = Path.resolve(
  __dirname,
  "../mac/Tests/TokenomicsMenubarTests/Fixtures/summary-v1.json",
);

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

function writeMacOSSummaryFixture() {
  fs.mkdirSync(Path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, `${JSON.stringify(buildMacOSSummaryFixture(), null, 2)}\n`);
}

if (require.main === module) writeMacOSSummaryFixture();

module.exports = {
  buildMacOSSummaryFixture,
  fixturePath,
  writeMacOSSummaryFixture,
};
