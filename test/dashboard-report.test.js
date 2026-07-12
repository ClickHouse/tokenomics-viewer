"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { dashboardHtml, webSummary } = require("../lib/dashboard");
const { newReport } = require("../app");
const { defaultOptions, statsFixture } = require("./support/fixtures");

test("dashboard summary keeps daily buckets chronological for time-series charts", () => {
  const report = newReport();
  report.daily["2026-01-03"] = statsFixture({ input: 30, cacheRead: 5, output: 3, costUsd: 3 });
  report.daily["2026-01-01"] = statsFixture({ input: 10, cacheRead: 2, output: 1, costUsd: 1 });
  report.daily["2026-01-02"] = statsFixture({ input: 20, cacheRead: 3, output: 2, costUsd: 2 });

  const summary = webSummary(report, defaultOptions());

  assert.deepEqual(summary.daily.map((row) => row.name), ["2026-01-01", "2026-01-02", "2026-01-03"]);
});

test("dashboard summary exposes per-project daily buckets for the project selector", () => {
  const report = newReport();
  report.projects["/tmp/project-a"] = statsFixture({ costUsd: 5 });
  report.projects["/tmp/project-b"] = statsFixture({ costUsd: 12 });
  report.projectDaily["/tmp/project-a"] = {
    "2026-01-02": statsFixture({ input: 20, cacheRead: 4, output: 2, costUsd: 2 }),
    "2026-01-01": statsFixture({ input: 30, cacheRead: 6, output: 3, costUsd: 3 }),
  };
  report.projectDaily["/tmp/project-b"] = {
    "2026-01-03": statsFixture({ input: 120, cacheRead: 40, output: 10, costUsd: 12 }),
  };

  const summary = webSummary(report, defaultOptions({ top: 10 }));

  assert.deepEqual(summary.projectDaily.map((project) => project.name), ["/tmp/project-b", "/tmp/project-a"]);
  assert.deepEqual(summary.projectDaily[1].daily.map((row) => row.name), ["2026-01-01", "2026-01-02"]);
});

test("dashboard html renders daily and cost mix with the shared canvas chart", () => {
  const html = dashboardHtml();

  assert.match(html, /id="daily-token-canvas"/);
  assert.match(html, /id="daily-token-hover-legend"/);
  assert.match(html, /id="cost-mix-canvas"/);
  assert.match(html, /id="cost-mix-hover-legend"/);
  assert.match(html, /id="efficiency-table"/);
  assert.match(html, /Output chars\/token p10\/avg\/p99/);
  assert.match(html, /Total \$\/1M priced out/);
  assert.match(html, /Output \$\/1M priced out/);
  assert.match(html, /Avg \$\/priced request/);
  assert.match(html, /Input Tokens/);
  assert.match(html, /Cache Tokens/);
  assert.match(html, /Output Tokens/);
  assert.match(html, /formatTokenCount/);
  assert.match(html, /formatUsdCompact/);
  assert.doesNotMatch(html, /\$\/1M priced tokens/);
  assert.match(html, /renderEfficiency/);
  assert.match(html, /renderSharedMixChart/);
  assert.match(html, /bindSharedMixCanvas/);
  assert.match(html, /drawSharedPoint/);
  assert.match(html, /drawSharedHoverGuide/);
  assert.match(html, /drawSharedPinnedMarker/);
  assert.doesNotMatch(html, /value \* Math\.PI \* 2/);
  assert.match(html, /Math\.max\(1, Math\.floor\(rect\.width/);
  assert.doesNotMatch(html, /Math\.max\(720, Math\.floor\(rect\.width/);
  assert.match(html, /tokenMix/);
  assert.match(html, /tokenScale/);
  assert.match(html, /Math\.log10/);
  assert.match(html, /drawCanvasCatmullRom/);
  assert.doesNotMatch(html, /id="daily-token-chart"/);
  assert.doesNotMatch(html, /svgEl\('/);
  assert.doesNotMatch(html, /document\.getElementById\('cost-mix'\)/);
});

test("dashboard html replaces sessions with a zoomable project canvas", () => {
  const html = dashboardHtml();

  assert.match(html, /id="project-select"/);
  assert.match(html, /id="project-cost-canvas"/);
  assert.match(html, /id="project-hover-legend"/);
  assert.match(html, /renderProjectDailyChart/);
  assert.match(html, /addEventListener\('wheel'/);
  assert.match(html, /zoomSharedChartAt/);
  assert.match(html, /drawSharedSelection/);
  assert.match(html, /bindSharedMixCanvas\(projectChart\)/);
  assert.match(html, /pinnedIndex: null/);
  assert.match(html, /summaryRow: selectedProject/);
  assert.match(html, /pinOnClick: true/);
  assert.match(html, /row\.name === 'Total'/);
  assert.match(html, /chart\.pinnedIndex =/);
  assert.match(html, /segmentShareText/);
  assert.match(html, /tokens \/ /);
  assert.match(html, /Cost Mix/);
  assert.match(html, /data-mix-mode="daily"/);
  assert.match(html, /data-mix-mode="weekly"/);
  assert.match(html, /data-mix-mode="monthly"/);
  assert.match(html, /data-mix-mode="models"/);
  assert.doesNotMatch(html, /<h2>Sessions<\/h2>/);
  assert.doesNotMatch(html, /fetch\('\/api\/sessions'\)/);
});

test("dashboard html exposes the operational overview layout", () => {
  const html = dashboardHtml();

  assert.match(html, /id="app-header"/);
  assert.match(html, /id="sync-dashboard"/);
  assert.match(html, /fetch\('\/api\/sync'/);
  assert.match(html, /x-tokenomics-action/);
  assert.match(html, /pollSyncStatus/);
  assert.match(html, /id="section-nav"/);
  assert.match(html, /data-section-target="overview-section"/);
  assert.match(html, /id="overview-section"/);
  assert.match(html, /id="models-section"/);
  assert.match(html, /id="projects-section"/);
  assert.match(html, /id="efficiency-section"/);
  assert.match(html, /id="daily-range-controls"/);
  assert.match(html, /data-range-days="90"/);
  assert.match(html, /id="model-ranking"/);
  assert.match(html, /renderModelRanking/);
  assert.match(html, /dailyRangeDays/);
  assert.match(html, /syncSectionNav/);
});

test("dashboard summary truncates top rows and preserves null metric serialization", () => {
  const report = newReport();
  report.models["model-a"] = statsFixture({ costUsd: 2, visibleCharsPerTokenMin: null });
  report.models["model-b"] = statsFixture({ costUsd: 1 });

  const summary = webSummary(report, defaultOptions({ top: 1 }));
  assert.deepEqual(summary.topModels.map((row) => row.name), ["model-a"]);
  const serialized = JSON.parse(JSON.stringify(summary));
  assert.equal(serialized.topModels[0].visibleCharsPerTokenMin, null);
  assert.equal(serialized.topModels[0].outputCharsPerTokenP99, null);
  assert.deepEqual(serialized.topModels[0].costsUsd, statsFixture().costsUsd);
});
