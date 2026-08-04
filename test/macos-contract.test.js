"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {
  buildMacOSSummaryFixture,
  buildMacOSSubscriptionSummaryFixture,
  fixturePath,
  subscriptionFixturePath,
} = require("../scripts/generate-macos-summary-fixture");

test("checked-in macOS fixture matches the current Node summary contract", () => {
  const checkedIn = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  assert.deepEqual(checkedIn, buildMacOSSummaryFixture());
  assert.equal(checkedIn.contractVersion, 1);
  assert.equal(checkedIn.budget.allowanceBasis, "monthly_limit_minus_spend_through_yesterday_divided_by_remaining_weekdays_utc");
});

test("checked-in macOS subscription fixture exposes server-owned quota windows", () => {
  const checkedIn = JSON.parse(fs.readFileSync(subscriptionFixturePath, "utf8"));

  assert.deepEqual(checkedIn, buildMacOSSubscriptionSummaryFixture());
  assert.equal(checkedIn.contractVersion, 1);
  assert.equal(checkedIn.costSemantics, "api-equivalent");
  assert.equal(checkedIn.billedCostUsd, null);
  assert.deepEqual(
    checkedIn.subscriptionWindows.map((window) => [window.windowMinutes, window.usedPercent, window.resetAt]),
    [
      [300, 68, "2026-08-03T13:24:00.000Z"],
      [10_080, 41, "2026-08-10T12:00:00.000Z"],
    ],
  );
});
