# Usage Profiles and Workflow Economics Frontier SDD

Document status: admitted implementation
Current frontier: one explicit usage profile per local workspace/database
Bounded context: billing semantics, subscription quota observations, API-equivalent
cost, API budgets, and workflow-efficiency recommendations

## Problem

The same token usage has different operational meaning in different accounts.
An API account incurs billable spend and is constrained by a monetary budget. A
subscription account consumes provider quota while its API list-price cost is a
useful counterfactual value, not an invoice. Combining these values under one
`Cost` or `remaining budget` label produces incorrect decisions.

The dashboard must preserve API-equivalent prices for subscription usage because
they help compare Luna, Sol, and reviewed delegation workflows, while keeping
quota and billed money as separate resources.

## Admitted Surface

- Configuration contains one explicit local usage profile with a stable mode:
  `api` or `subscription`, plus a user-visible name.
- Existing databases default to an `api` profile to preserve historical monthly
  budget behavior.
- Standard or custom API prices are evaluated in both modes.
- In `api` mode, cost is an estimated billed cost and the optional monthly USD
  limit is active.
- In `subscription` mode, cost is labeled API equivalent and the monthly USD
  limit is inactive.
- Subscription summaries expose every currently reported provider quota window
  by its observed `window_minutes`; no primary/secondary name is assumed to mean
  5 hours or one week.
- A quota window exposes latest used/remaining percentage, reset time,
  API-equivalent cost observed within its current time bounds, pricing coverage,
  and model cost composition.
- Absent windows are absent or marked not reported. They are never synthesized
  as zero usage.
- Reset timestamps within a bounded jitter tolerance identify the same provider
  window rather than manufacturing resets.
- Recommendations remain deterministic and state whether they optimize API
  spend, subscription quota, or API-equivalent value.

## Rejected Surface

- Adding subscription API-equivalent cost to API billed cost and presenting the
  result as one spend or remaining-budget value.
- Treating API-equivalent subscription cost as a provider invoice.
- Inferring account/profile identity from project path, model, plan type, or
  provider account labels in session payloads.
- Claiming exact per-model quota consumption when several models produced usage
  between rounded provider quota observations.
- Treating a missing 5-hour window as zero usage or a parser failure.
- Supporting mixed profiles in one local database before sources and usage rows
  carry an explicit profile id.
- Using project completion, token volume, or API price alone as a proof of equal
  task quality.

## Guard-Only Future

- Multiple usage profiles per workspace with source-level profile assignment.
- Root-task workflow grouping using parent session ids and agent roles.
- Matched comparisons of Sol-direct and Luna-plus-Sol-review workflows.
- Estimated quota weights by model from single-model or strongly dominated
  observation intervals, with explicit confidence and sample counts.
- Hosted workspace-scoped profiles after the tenancy/Auth frontier is admitted.

## Design Laws

1. Billing semantics are typed data, not display copy inferred from a number.
2. `billed_cost_usd`, `api_equivalent_cost_usd`, and `quota_percent` never
   substitute for one another.
3. A monetary budget belongs only to an API profile.
4. Quota windows are provider observations keyed by duration and limit identity,
   not product-policy constants.
5. Missing observations produce unknown/not-reported state, never zero.
6. Model-level quota claims require an identifiable attribution interval;
   mixed intervals remain estimates or are rejected.
7. Recommendations state evidence, scope, proxy limitation, and confidence.

## Execution Order

1. Add and validate the local profile configuration while preserving old
   database compatibility.
2. Propagate profile semantics into SQLite and ClickHouse reports.
3. Normalize quota reset jitter and expose current-window economics.
4. Render API and subscription KPI surfaces with distinct labels.
5. Add deterministic budget/quota recommendations with coverage caveats.
6. Add source-level profile ids before admitting multiple profiles in one
   database.
7. Add root-task workflow economics only after parent/session provenance is
   queryable without loading session bodies.

## Falsifier Roster

- Legacy configuration normalizes to the default API profile without changing
  pricing rows.
- Unsupported profile modes, empty names, and subscription profiles with an
  active monthly USD budget fail validation.
- API mode exposes monthly spend/limit while subscription mode does not expose a
  billed monthly remainder.
- Subscription mode retains the same API-equivalent total as API mode for the
  same priced usage.
- A report containing only a 10080-minute window does not synthesize a 300-minute
  window.
- Reset timestamps differing by a few seconds do not increment reset count.
- Current-window API-equivalent cost includes all priced usage buckets in the
  window, not only snapshots where rounded quota percentage changes.
- Partial pricing coverage is visible and prevents an unqualified exact-cost
  recommendation.
- SQLite and ClickHouse return identical normalized profile configuration.
- Existing API dashboard tests remain green.

## Stop Rules

- Do not admit multiple profiles until every source and usage query has an
  explicit profile boundary.
- Do not call subscription API equivalent billed or spent money.
- Do not recommend a model as equal quality from cost/quota telemetry alone.
- Do not report exact model quota savings from mixed rounded observations.

## Implementation Seal

- Slice: single-profile billing semantics and subscription window economics
- Source/spec: `lib/core/configuration.js`, `lib/core/rate-limits.js`,
  `lib/dashboard.js`, `lib/storage/`, `lib/recommendations.js`,
  `public/index.html`
- Falsifiers: configuration, rate-limit, dashboard, recommendation, SQLite, and
  ClickHouse tests
- Boundary: local single-user workspace; one profile per database
- Evidence: 184 automated tests across configuration, rate limits, dashboard,
  recommendations, SQLite, ClickHouse, and web API behavior; desktop and mobile
  browser verification against a real SQLite import; read-only report build
  against a local ClickHouse database
- Next local track: source-scoped profiles and root-task workflow economics
