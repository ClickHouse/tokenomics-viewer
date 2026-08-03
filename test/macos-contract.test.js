"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {
  buildMacOSSummaryFixture,
  fixturePath,
} = require("../scripts/generate-macos-summary-fixture");

test("checked-in macOS fixture matches the current Node summary contract", () => {
  const checkedIn = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

  assert.deepEqual(checkedIn, buildMacOSSummaryFixture());
  assert.equal(checkedIn.contractVersion, 1);
  assert.equal(checkedIn.budget.allowanceBasis, "monthly_limit_minus_spend_through_yesterday_divided_by_remaining_weekdays_utc");
});
