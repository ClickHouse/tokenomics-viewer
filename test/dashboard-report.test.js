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

test("dashboard summary exposes chronological provider, model, and effort daily groups", () => {
  const report = newReport();
  report.providerModelEffortDaily = {
    openai: {
      "gpt-5.5": {
        high: {
          "2026-01-03": statsFixture({ input: 30, cacheRead: 5, output: 3, costUsd: 3 }),
          "2026-01-01": statsFixture({ input: 10, cacheRead: 2, output: 1, costUsd: 1 }),
        },
      },
    },
    anthropic: {
      "gpt-5.5": {
        "<unknown>": {
          "2026-01-02": statsFixture({ input: 4, cacheRead: 3, output: 2, costUsd: 1 }),
        },
      },
    },
  };

  const summary = webSummary(report, defaultOptions());

  assert.ok(Array.isArray(summary.providerModelEffortDaily));
  assert.equal(summary.providerModelEffortDaily.length, 2, "providers with the same model name must stay separate");
  const openai = summary.providerModelEffortDaily.find((group) => group.provider === "openai");
  assert.deepEqual(openai.daily.map((row) => row.name), ["2026-01-01", "2026-01-03"]);
  assert.deepEqual(
    Object.fromEntries(["provider", "model", "effort"].map((key) => [key, openai[key]])),
    { provider: "openai", model: "gpt-5.5", effort: "high" },
  );
  assert.deepEqual(
    Object.fromEntries(["input", "cacheRead", "output", "costUsd"].map((key) => [key, openai.daily[0][key]])),
    { input: 10, cacheRead: 2, output: 1, costUsd: 1 },
  );
  assert.equal(Object.hasOwn(openai.daily[0], "outputCharsPerTokenSum"), false, "date-filter payload should stay usage-only");
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
  const costMixControls = html.slice(html.indexOf('id="cost-mix-controls"'), html.indexOf('</section>', html.indexOf('id="cost-mix-controls"')));
  const costMixRenderer = html.slice(html.indexOf("function renderCostMix"), html.indexOf("function renderEfficiency"));
  assert.doesNotMatch(costMixControls, /data-mix-mode="models"/);
  assert.doesNotMatch(costMixRenderer, /costMixMode === 'models'/);
  assert.doesNotMatch(html, /<h2>Sessions<\/h2>/);
  assert.doesNotMatch(html, /fetch\('\/api\/sessions'\)/);
});

test("dashboard html exposes a standalone models table and relative and absolute date filters", () => {
  const html = dashboardHtml();

  assert.ok(html.includes('<section id="models-section">'));
  assert.ok(html.includes('id="models-table"'), "expected a standalone models table");
  assert.match(html, /id="model-date-mode-controls"/);
  assert.match(html, /data-model-date-mode="relative"/);
  assert.match(html, /data-model-date-mode="absolute"/);
  assert.match(html, /id="model-relative-range"/);
  assert.match(html, /<th>Effort<\/th>/);
  assert.match(html, /<th>Input tokens<\/th>/);
  assert.match(html, /<th>Cache tokens<\/th>/);
  assert.match(html, /<th>Output tokens<\/th>/);
  assert.doesNotMatch(html, /formatTokenCount\(segmentTokens\(row, key\)\)\) \+ ' tokens'/);

  assert.match(html, /id="daily-range-controls"[\s\S]*data-range-days="all"/);
  const dateInputs = html.match(/<input\b[^>]*type=["']date["'][^>]*>/g) || [];
  assert.ok(dateInputs.length >= 2, "expected absolute start and end date controls");
});

test("Daily Token Flow value text includes total tokens and total USD cost", () => {
  const html = dashboardHtml();
  const chartSource = html.slice(html.indexOf("function renderDailyTokenChart"), html.indexOf("function bindSharedMixCanvas"));

  assert.match(chartSource, /valueText: row =>[\s\S]*formatTokenCount\(totalTokens\(row\)\)/);
  assert.match(chartSource, /valueText: row =>[\s\S]*formatUsdCompact\(row\.costUsd \|\| 0\)/);
});

test("dashboard html exposes the operational overview layout", () => {
  const html = dashboardHtml();

  assert.match(html, /id="app-header"/);
  assert.match(html, /id="sync-dashboard"/);
  assert.match(html, /fetch\('\/api\/sync'/);
  assert.match(html, /x-tokenomics-action/);
  assert.match(html, /pollSyncStatus/);
  assert.match(html, /new EventSource\('\/api\/sync\/events'\)/);
  assert.match(html, /changedSources/);
  assert.match(html, /sync\.available/);
  assert.match(html, /await loadSummary\(\);\s*renderSyncStatus\(sync\);/);
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
  assert.match(html, /data-dashboard-mode="overview"/);
  assert.match(html, /data-dashboard-mode="analyst"/);
  assert.match(html, /id="recommendations-section"/);
  assert.match(html, /renderRecommendations/);
  assert.match(html, /dashboardMode/);
  assert.match(html, /overviewModelLimit/);
});

test("dashboard summary keeps Luna available beyond the overview model limit", () => {
  const report = newReport();
  for (let index = 0; index < 12; index += 1) {
    report.models[`model-${index}`] = statsFixture({ costUsd: 100 - index });
  }
  report.models["gpt-5.6-luna"] = statsFixture({ requests: 500, costUsd: 50 });

  const summary = webSummary(report, defaultOptions({ top: 25 }));

  assert.equal(summary.topModels.length, 13);
  assert.ok(summary.topModels.some((model) => model.name === "gpt-5.6-luna"));
  assert.equal(summary.models.length, 13);
  assert.ok(summary.models.some((model) => model.name === "gpt-5.6-luna"));
  assert.ok(Array.isArray(summary.recommendations));
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
