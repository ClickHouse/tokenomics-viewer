"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { dashboardHtml, webSummary, webTimeline } = require("../lib/dashboard");
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

test("dashboard serves compact 15-minute timelines separately from the summary", () => {
  const report = newReport();
  report.quarterHourly["2026-01-02T12:00Z"] = statsFixture({ costUsd: 3 });
  report.quarterHourly["2026-01-01T12:15Z"] = statsFixture({ costUsd: 2 });
  report.quarterHourly["2026-01-01T12:00Z"] = statsFixture({ costUsd: 1 });
  report.quarterHourlyProviderModels["2026-01-01T12:00Z"] = {
    openai: { "shared-model": statsFixture({ input: 10, costUsd: 1 }) },
  };
  report.projects["/tmp/project-a"] = statsFixture({ costUsd: 3 });
  report.projectQuarterHourly["/tmp/project-a"] = {
    "2026-01-01T12:15Z": statsFixture({ costUsd: 2 }),
    "2026-01-01T12:00Z": statsFixture({ costUsd: 1 }),
  };
  report.projectQuarterHourlyProviderModels["/tmp/project-a"] = {
    "2026-01-01T12:00Z": { openai: { "shared-model": statsFixture({ input: 10, costUsd: 1 }) } },
  };

  const summary = webSummary(report, defaultOptions());
  const globalTimeline = webTimeline(report);
  const recentTimeline = webTimeline(report, { days: 1 });
  const absoluteTimeline = webTimeline(report, { from: "2026-01-01", to: "2026-01-01" });
  const projectTimeline = webTimeline(report, { project: "/tmp/project-a" });

  assert.equal(summary.timeline, undefined);
  assert.equal(summary.projectDaily[0].timeline, undefined);
  assert.deepEqual(globalTimeline.map((row) => row.name), ["2026-01-01T12:00Z", "2026-01-01T12:15Z", "2026-01-02T12:00Z"]);
  assert.equal(globalTimeline[0].models[0].name, "openai/shared-model");
  assert.deepEqual(recentTimeline.map((row) => row.name), ["2026-01-02T12:00Z"]);
  assert.deepEqual(absoluteTimeline.map((row) => row.name), ["2026-01-01T12:00Z", "2026-01-01T12:15Z"]);
  assert.deepEqual(projectTimeline.map((row) => row.name), ["2026-01-01T12:00Z", "2026-01-01T12:15Z"]);
  assert.equal(projectTimeline[0].models[0].name, "openai/shared-model");
  assert.deepEqual(Object.keys(globalTimeline[0]).sort(), ["cacheCreate1h", "cacheCreate30m", "cacheCreate5m", "cacheRead", "costUsd", "costsUsd", "input", "models", "name", "output", "pricedRequests", "requests"]);
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
  assert.deepEqual(
    Object.fromEntries(["pricedRequests", "pricedInput", "pricedCacheRead", "pricedOutput", "pricedReasoningOutput"].map((key) => [key, openai.daily[0][key]])),
    { pricedRequests: 0, pricedInput: 0, pricedCacheRead: 0, pricedOutput: 0, pricedReasoningOutput: 0 },
  );
  assert.equal(Object.hasOwn(openai.daily[0], "outputCharsPerTokenSum"), false, "date-filter payload should stay usage-only");
});

test("dashboard summary preserves priced cohort counters for model effort diagnostics", () => {
  const report = newReport();
  report.providerModelEffortDaily.openai = {
    "gpt-5.6-sol": {
      high: {
        "2026-07-13": statsFixture({
          requests: 4,
          pricedRequests: 3,
          pricedInput: 100,
          pricedCacheRead: 900,
          pricedOutput: 40,
          pricedReasoningOutput: 10,
          reasoningOutput: 12,
          costUsd: 2,
        }),
      },
    },
  };

  const summary = webSummary(report, defaultOptions());
  const row = summary.providerModelEffortDaily[0].daily[0];

  assert.equal(row.pricedRequests, 3);
  assert.equal(row.pricedInput, 100);
  assert.equal(row.pricedCacheRead, 900);
  assert.equal(row.pricedOutput, 40);
  assert.equal(row.pricedReasoningOutput, 10);
  assert.equal(row.reasoningOutput, 12);
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
  report.projectProviderModels["/tmp/project-a"] = {
    openai: {
      "shared-model": statsFixture({ requests: 2, pricedRequests: 2, costUsd: 4 }),
    },
    "acme-ai": {
      "shared-model": statsFixture({ requests: 1, unpricedRequests: 1, costUsd: 1 }),
    },
  };

  const summary = webSummary(report, defaultOptions({ top: 10 }));

  assert.deepEqual(summary.projectDaily.map((project) => project.name), ["/tmp/project-b", "/tmp/project-a"]);
  assert.deepEqual(summary.projectDaily[1].daily.map((row) => row.name), ["2026-01-01", "2026-01-02"]);
  assert.deepEqual(summary.projectDaily[1].models.map((row) => row.name), ["openai/shared-model", "acme-ai/shared-model"]);
  assert.deepEqual(summary.projectDaily[1].models.map((row) => row.provider), ["openai", "acme-ai"]);
  assert.equal(summary.projectDaily[1].models[1].unpricedRequests, 1);
});

test("dashboard html renders Token Flow without a duplicate Cost Mix chart", () => {
  const html = dashboardHtml();

  assert.match(html, /id="daily-token-canvas"/);
  assert.match(html, /id="daily-token-hover-legend"/);
  assert.doesNotMatch(html, /id="cost-mix-canvas"/);
  assert.doesNotMatch(html, /id="cost-mix-hover-legend"/);
  assert.doesNotMatch(html, /<h2>Cost Mix<\/h2>/);
  assert.match(html, /id="efficiency-table"/);
  assert.match(html, /Cost &amp; Resource Diagnostics/);
  assert.match(html, /id="efficiency-model-select"/);
  assert.match(html, /Amortized \$\/1M output/);
  assert.match(html, /Output tariff \$\/1M/);
  assert.match(html, /Avg \$\/covered event/);
  assert.match(html, /Tariff coverage/);
  assert.doesNotMatch(html, /Output chars\/token p10\/avg\/p99/);
  assert.doesNotMatch(html, /Total \$\/1M priced out/);
  assert.doesNotMatch(html, /Avg \$\/priced request/);
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
  assert.match(html, /WHEEL_ZOOM_DELTA_STEP/);
  assert.match(html, /wheelZoomDelta/);
  assert.match(html, /consumeWheelZoomSteps/);
  assert.doesNotMatch(html, /direction < 0 \? 0\.72 : 1\.38/);
  assert.match(html, /drawSharedSelection/);
  assert.match(html, /bindSharedMixCanvas\(projectChart\)/);
  assert.match(html, /pinnedIndex: null/);
  assert.match(html, /summaryRow: \{ name: 'Total'/);
  assert.match(html, /pinOnClick: true/);
  assert.match(html, /row\.name === 'Total'/);
  assert.match(html, /chart\.pinnedIndex =/);
  assert.match(html, /segmentShareText/);
  assert.match(html, /Tariff coverage/);
  assert.match(html, /Cache write/);
  assert.match(html, /Cache read/);
  assert.match(html, /project-model-breakdown/);
  assert.match(html, /tokens \/ /);
  assert.doesNotMatch(html, /costMixMode/);
  assert.doesNotMatch(html, /renderCostMix/);
  assert.doesNotMatch(html, /<h2>Sessions<\/h2>/);
  assert.doesNotMatch(html, /fetch\('\/api\/sessions'\)/);
});

test("dashboard exposes a database-backed pricing settings editor", () => {
  const html = dashboardHtml();

  assert.match(html, /id="pricing-settings"/);
  assert.match(html, /id="pricing-table"/);
  assert.match(html, /id="save-pricing"/);
  assert.match(html, /\/api\/configuration/);
  assert.match(html, /x-tokenomics-action/);
  assert.match(html, /data-dashboard-mode="settings"/);
  assert.match(html, /body\[data-dashboard-mode="settings"\] #pricing-settings/);
  assert.doesNotMatch(html, /data-section-target="pricing-settings"/);
});

test("dashboard html exposes per-chart relative and absolute date filters with adaptive resolution", () => {
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

  assert.match(html, /id="token-date-mode-controls"/);
  assert.match(html, /id="token-relative-range"/);
  assert.match(html, /id="token-date-from"/);
  assert.match(html, /id="token-date-to"/);
  assert.match(html, /id="project-date-mode-controls"/);
  assert.match(html, /id="project-relative-range"/);
  assert.match(html, /id="project-date-from"/);
  assert.match(html, /id="project-date-to"/);
  assert.match(html, /id="token-interaction-controls"/);
  assert.match(html, /id="project-interaction-controls"/);
  assert.match(html, /data-chart-interaction="pan"/);
  assert.match(html, /data-chart-interaction="zoom"/);
  assert.match(html, /class="chart-help"/);
  assert.match(html, /Hover anywhere: inspect the nearest interval/);
  assert.match(html, /Wheel: zoom at pointer/);
  assert.doesNotMatch(html, /token-resolution-controls/);
  assert.doesNotMatch(html, /project-resolution-controls/);
  assert.doesNotMatch(html, /data-mix-mode=/);
  assert.match(html, /TokenomicsTimeline\.chooseAdaptiveResolution/);
  assert.match(html, /TokenomicsTimeline\.zoomDomain/);
  assert.match(html, /TokenomicsTimeline\.panDomain/);
  assert.match(html, /TokenomicsTimeline\.nearestPointByX/);
  assert.match(html, /createCategoricalColorScale/);
  assert.match(html, /aggregateTimelineRows/);
  assert.match(html, /src="\/timeline\.js"/);
  assert.match(html, /drawSharedModelSeries/);
  assert.match(html, /className = 'chart-tooltip'/);
  assert.match(html, /modelColor/);
  assert.match(html, /currentTime - previousTime > config\.intervalMs/);
  const dateInputs = html.match(/<input\b[^>]*type=["']date["'][^>]*>/g) || [];
  assert.ok(dateInputs.length >= 6, "expected absolute start and end controls for both charts and the model table");
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
  assert.match(html, /id="token-date-mode-controls"/);
  assert.match(html, /id="project-date-mode-controls"/);
  assert.match(html, /id="model-ranking"/);
  assert.match(html, /renderModelRanking/);
  assert.match(html, /timelineRanges/);
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
