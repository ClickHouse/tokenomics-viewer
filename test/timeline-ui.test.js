"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const timeline = require("../public/timeline");

test("adaptive resolution selects the finest bucket within the point budget", () => {
  const start = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(timeline.chooseAdaptiveResolution(start, start + 90 * timeline.DAY_MS, 160), "daily");
  assert.equal(timeline.chooseAdaptiveResolution(start, start + 5 * timeline.DAY_MS, 160), "hourly");
  assert.equal(timeline.chooseAdaptiveResolution(start, start + timeline.DAY_MS, 160), "15m");
  assert.equal(timeline.chooseAdaptiveResolution(start, start + 180 * timeline.DAY_MS, 160), "weekly");
  assert.equal(timeline.chooseAdaptiveResolution(start, start + 365 * timeline.DAY_MS, 160), "monthly");
  assert.equal(timeline.chooseAdaptiveResolution(start, start + 3 * 365 * timeline.DAY_MS, 160), "yearly");
});

test("calendar-month range covers month-to-date instead of a rolling window", () => {
  assert.deepEqual(timeline.rangeDomain({
    mode: "relative",
    calendarMonth: true,
    monthStartAt: "2026-07-01T04:00:00.000Z",
    monthEndAt: "2026-07-18T04:00:00.000Z",
    availableFrom: "2025-01-01",
    availableTo: "2026-07-17",
  }), {
    start: Date.parse("2026-07-01T04:00:00Z"),
    end: Date.parse("2026-07-18T04:00:00Z"),
  });
});

test("relative range clamps to one available day and starts at 15-minute resolution", () => {
  const domain = timeline.rangeDomain({
    mode: "relative",
    days: 30,
    availableFrom: "2026-07-14",
    availableTo: "2026-07-14",
  });

  assert.deepEqual(domain, {
    start: Date.parse("2026-07-14T00:00:00Z"),
    end: Date.parse("2026-07-15T00:00:00Z"),
  });
  assert.equal(timeline.chooseAdaptiveResolution(domain.start, domain.end, 96), "15m");
});

test("relative range keeps the requested trailing window when enough data exists", () => {
  const domain = timeline.rangeDomain({
    mode: "relative",
    days: 30,
    availableFrom: "2026-01-01",
    availableTo: "2026-07-14",
  });

  assert.equal(new Date(domain.start).toISOString(), "2026-06-15T00:00:00.000Z");
  assert.equal(new Date(domain.end).toISOString(), "2026-07-15T00:00:00.000Z");
});

test("wheel zoom keeps its pointer anchor inside the selected range", () => {
  const full = { start: 0, end: 100 * timeline.DAY_MS };
  const zoomed = timeline.zoomDomain(full, full, 0.75, -1);
  const beforeAnchor = full.start + (full.end - full.start) * 0.75;
  const afterAnchor = zoomed.start + (zoomed.end - zoomed.start) * 0.75;
  assert.equal(afterAnchor, beforeAnchor);
  assert.ok(zoomed.start >= full.start);
  assert.ok(zoomed.end <= full.end);
  assert.ok(zoomed.end - zoomed.start < full.end - full.start);
});

test("zoom cannot shrink below one 15-minute bucket", () => {
  const full = { start: 0, end: timeline.DAY_MS };
  let domain = full;
  for (let index = 0; index < 100; index += 1) domain = timeline.zoomDomain(domain, full, 0.5, -3);
  assert.equal(domain.end - domain.start, timeline.QUARTER_HOUR_MS);
});

test("bucket names are stable UTC boundaries", () => {
  assert.equal(timeline.bucketName("2026-07-14T12:45Z", "15m"), "2026-07-14T12:45Z");
  assert.equal(timeline.bucketName("2026-07-14T12:45Z", "hourly"), "2026-07-14T12:00Z");
  assert.equal(timeline.bucketName("2026-07-14T12:45Z", "daily"), "2026-07-14");
  assert.equal(timeline.bucketName("2026-07-14T12:45Z", "weekly"), "2026-07-13");
  assert.equal(timeline.bucketName("2026-07-14T12:45Z", "monthly"), "2026-07");
  assert.equal(timeline.bucketName("2026-07-14T12:45Z", "yearly"), "2026");
  assert.equal(timeline.resolutionIntervalMs("weekly"), 7 * timeline.DAY_MS);
  assert.equal(new Date(timeline.periodStart("2026")).toISOString(), "2026-01-01T00:00:00.000Z");
});

test("calendar bucket centers use actual month and year lengths", () => {
  const leapFebruaryStart = Date.parse("2024-02-01T00:00:00Z");
  const leapMarchStart = Date.parse("2024-03-01T00:00:00Z");
  assert.equal(
    timeline.bucketCenter("2024-02", "monthly"),
    leapFebruaryStart + (leapMarchStart - leapFebruaryStart) / 2,
  );

  const yearStart = Date.parse("2024-01-01T00:00:00Z");
  const nextYearStart = Date.parse("2025-01-01T00:00:00Z");
  assert.equal(
    timeline.bucketCenter("2024", "yearly"),
    yearStart + (nextYearStart - yearStart) / 2,
  );
});

test("categorical colors stay stable and avoid palette collisions", () => {
  const colorFor = timeline.createCategoricalColorScale(["red", "green", "blue"]);
  const sol = colorFor("openai/gpt-5.6-sol");
  const luna = colorFor("openai/gpt-5.6-luna");
  assert.notEqual(sol, luna);
  assert.equal(colorFor("openai/gpt-5.6-sol"), sol);
});

test("pan preserves span and clamps to the selected date range", () => {
  const full = { start: 0, end: 10 * timeline.DAY_MS };
  const current = { start: 4 * timeline.DAY_MS, end: 6 * timeline.DAY_MS };
  const earlier = timeline.panDomain(current, full, 0.5);
  assert.deepEqual(earlier, { start: 3 * timeline.DAY_MS, end: 5 * timeline.DAY_MS });
  const clamped = timeline.panDomain(current, full, 100);
  assert.deepEqual(clamped, { start: 0, end: 2 * timeline.DAY_MS });
});

test("bounded cache evicts old timeline ranges", () => {
  const cache = new Map();
  timeline.rememberBounded(cache, "range-1", [1], 2);
  timeline.rememberBounded(cache, "range-2", [2], 2);
  timeline.rememberBounded(cache, "range-3", [3], 2);

  assert.deepEqual([...cache.keys()], ["range-2", "range-3"]);
  assert.deepEqual(cache.get("range-3"), [3]);
});

test("hover selects the nearest time point by horizontal position", () => {
  const points = [
    { x: 20, id: "first" },
    { x: 80, id: "second" },
    { x: 140, id: "third" },
  ];

  assert.equal(timeline.nearestPointByX(points, 72).id, "second");
  assert.equal(timeline.nearestPointByX(points, 111).id, "third");
  assert.equal(timeline.nearestPointByX([], 50), null);
});
