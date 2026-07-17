# Timeline Resolution Frontier SDD

Document status: implemented and verified
Current frontier: range-bounded timelines with adaptive resolution

## Admitted Surface

- Usage events with valid timestamps aggregate into canonical UTC 15-minute
  buckets for direct scans, SQLite reports, and ClickHouse reports.
- The dashboard may fold those buckets into hourly, daily, weekly, monthly, or
  yearly rows without repricing or averaging rates.
- Token Flow and Project Cost each expose an independent `Relative | Absolute`
  date range. Relative ranges are anchored to the latest measured row;
  absolute bounds are inclusive UTC calendar dates. Both charts default to a
  one-month relative range.
- Wheel and selection zoom operate only inside the selected date range. The
  visible domain automatically selects yearly, monthly, weekly, daily, hourly,
  or 15-minute buckets to keep the chart readable while preserving 15-minute
  drill-down.
- Each chart has explicit `Pan | Zoom` pointer modes. Pan drag and horizontal
  trackpad scroll move the visible domain without escaping the selected range;
  Zoom drag selects a smaller domain. Wheel zoom remains pointer-anchored.
- A compact mouse-help control documents wheel zoom, Pan drag, Zoom selection,
  nearest-interval hover, and double-click reset without permanently occupying
  chart space.
- Token Flow carries both token and cost details. Its `Tokens | Cost` value
  control changes the vertical measure, component percentages, and model share
  without changing the selected range or zoom domain. A separate Cost Mix chart
  is rejected because it visualizes the same rows and cost components.
- The Cost KPI shows all-time spend as its primary value and the current local
  calendar month's spend as secondary context. The month key is computed with
  the same local-calendar rule as report aggregation.
- Missing or invalid timestamps remain in total aggregates but are excluded from
  intraday timelines.
- The summary payload excludes intraday rows. `/api/timeline` returns a compact
  global range or one explicitly selected project on demand.
- The browser retains at most the current and previous global and project
  timeline responses, preventing arbitrary absolute ranges from growing an
  unbounded in-tab cache.
- Each provider/model is a stable-color point and Catmull-Rom line series.
  Missing model usage or a missing source interval terminates that model's line.
  Visible models receive distinct categorical colors until the expanded palette
  is exhausted; hash collisions may not silently reuse a color.
- Hover or a pinned project interval shows total cost/tokens plus per-model
  `cost / tokens / share`; the chart header remains the aggregate interval mix.

## Rejected Surface

- Fabricating empty intervals or interpolating missing usage as measured data.
- Treating browser-local time as a storage key. Labels may be localized, while
  the API key remains UTC.
- Persisting another timestamp column solely for this view.
- Returning raw event rows to the browser for client-side aggregation.
- User-selected resolution tabs. Resolution is a rendering decision derived
  from the visible time domain, not a second data-range control.
- A separate Cost Mix chart that duplicates Token Flow.

## Design Laws

1. A 15-minute bucket is `[floor(timestamp/15m), +15m)` in UTC.
2. Coarser rows are sums of complete finer rows; cost components and tariff
   coverage counters must remain additive.
3. Zoom is represented as UTC time bounds, never row indexes, because row
   indexes are not stable across bucket widths.
4. Adaptive resolution selects the finest bucket that stays within the chart's
   point budget; the minimum domain is one 15-minute bucket.
5. A relative range is intersected with the measured data bounds. A project
   with one measured day starts with a one-day domain and 15-minute buckets,
   never a mostly empty month-long domain with one daily point.
6. A one-point view is valid and must not divide by zero or resize the canvas.
7. Sparse usage is not zero usage: model lines must break instead of connecting
   across an interval where that model has no row.
8. Intraday payload is demand-driven. The initial summary must not include every
   project timeline.
9. Range caching is bounded independently for global and project timelines;
   cache eviction may cost another request but must not change chart totals.
10. Switching the Token Flow value measure preserves the current UTC domain;
    token percentages use token totals and cost percentages use cost totals.
11. The current-month KPI is a presentation slice of the existing monthly
    aggregate; it never triggers ingestion, repricing, or another timeline scan.

## Falsifiers

- Timestamps at `:14:59.999` and `:15:00.000` land in adjacent buckets.
- Equal project events in separate quarter-hours remain separate in direct,
  SQLite, and ClickHouse summaries.
- Hourly folding equals the sum of its four quarter-hour rows, including cache
  creation/read cost and priced/unpriced counters.
- Invalid timestamps do not create a `1970` or `unknown` intraday point.
- A 90-day domain renders daily buckets, a one-year domain renders weekly
  buckets, a five-year domain renders monthly buckets, a 30-year domain renders
  yearly buckets, a five-day domain renders hourly buckets, and a one-day
  domain renders 15-minute buckets at the standard point budget.
- A 30-day relative selection over a project with only one measured day clamps
  to that day and starts at 15-minute resolution.
- Wheel anchoring preserves the timestamp under the pointer, never exceeds the
  selected range, and can reach one 15-minute interval.
- Pan preserves domain width, clamps at both selected-range boundaries, and is
  reversible without changing aggregation totals.
- Absolute `from` and `to` dates include every 15-minute row on both boundary
  dates; invalid or reversed bounds are rejected by the API.
- A model absent from the middle interval produces two disconnected runs.
- The initial summary has no `timeline` branch; project selection fetches only
  that project's compact timeline.
- Dashboard HTML contains no Cost Mix canvas and no explicit timeline
  resolution controls.
- Switching `Tokens | Cost` keeps the chart data key stable, retains the zoomed
  domain, and changes the tooltip percentage denominator with the selected
  measure.
- Adjacent monthly buckets around report time do not leak into the current-month
  KPI; a month without usage renders zero rather than an absent value.
- Two model identifiers with the same initial palette hash receive different,
  stable colors.
- A third requested timeline range evicts the oldest of the two cached ranges.
- Hover anywhere inside the plot selects the nearest interval by horizontal
  position, draws a neutral vertical guide, and does not require hitting a
  marker by both coordinates.

## Evidence

- Unit and API falsifiers: `test/pricing-usage.test.js`, `test/sqlite.test.js`,
  `test/clickhouse.test.js`, `test/dashboard-report.test.js`, and
  `test/web.test.js`.
- Real ClickHouse browser probe on 2026-07-14: daily, 15-minute, and hourly
  canvases rendered colored sparse model series, per-interval model popup,
  pointer-anchored zoom, bounded pan, selection zoom, and responsive help.
- Real ClickHouse payload probe on the same dataset: the former eager summary
  was 68.7 MB; the lazy summary was 4.46 MB, a 90-day global timeline 6.51 MB,
  and the selected project's all-time timeline 4.00 MB.
- Full suite on 2026-07-17: `npm test` passed all 168 tests. Desktop and 390px
  browser smokes on a real ClickHouse report confirmed the current-month KPI,
  Tokens/Cost switching, responsive controls, and zero console errors or
  warnings.

## Implementation Seal

- Slice: adaptive Token Flow and Project Cost date domains.
- Source/spec: `public/index.html`, `public/timeline.js`, `lib/dashboard.js`,
  `lib/web-server.js`.
- Falsifiers: pure domain/bucket tests, timeline API boundary tests, dashboard
  source-shape guards, and desktop/mobile browser probes.
- Boundary: the server still returns compact measured 15-minute rows; the
  browser may aggregate them but may not fabricate empty intervals.
