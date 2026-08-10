# Harness Format and Service Mode Frontier

Document status: design-sealed
Current frontier: exact usage events from explicit local harness telemetry, with
provider-specific tier metadata kept separate from canonical standard/fast mode
Bounded context: local session discovery, parsing, normalized usage storage, and
dashboard breakdowns

## Context Bridge: Observed Session to Usage Evidence

- Left context: harness-local session storage.
- Left term and sense: `observed session` means a real local transcript or
  session record with a stable source path and harness-native boundaries.
- Right context: normalized token and cost analytics.
- Right term and sense: `exact usage` means native token counters whose
  input/cache/output semantics are known for the recorded request.
- Relation: an observed session is evidence that work happened, but is not
  evidence of exact usage.
- Confidence: high for the distinction; per-harness confidence comes from
  fixtures and live schema probes.
- Allowed use: discover and count observed sessions; expose an explicit
  measurement provenance; estimate only in a separately labelled surface.
- Disallowed use: price message text, context snapshots, file size, or mtime as
  exact request telemetry, or silently add those estimates to exact totals.
- Decay trigger: a harness format/version change or the appearance of new native
  usage fields requires a fresh probe and fixture.

## Admitted Surface

- Codex JSONL and archive ingestion keeps fork replay exclusion and reads
  `thread_settings_applied.thread_settings.service_tier`.
- Claude Code assistant usage may expose `usage.speed` independently from
  `usage.service_tier`.
- Claude transcript/API spelling `standard` and OpenTelemetry spelling `normal`
  both normalize to canonical `standard`; `fast` remains `fast`.
- Packaged Anthropic pricing recognizes canonical `claude-opus-5` and
  `claude-opus-4-8` at the same standard rates and applies the same verified
  fast tariff to both.
- Canonical service mode is `standard`, `fast`, or `unknown`. Unknown values
  remain unknown and never silently receive fast pricing.
- Provider-specific tier and canonical service mode remain separate stored
  dimensions.
- New harness adapters must preserve the billing provider separately from the
  harness/agent identity.
- Exact token counters may be normalized when their cache semantics are known
  and covered by a fixture.
- Cursor Agent transcripts, Grok Build sessions, and GitHub Copilot CLI/VS Code
  sessions are admitted as
  `observed-only` metadata coverage. They retain agent/provider/model/project
  identity and source-timestamp provenance; Grok may retain context-token
  snapshots from `signals.json`. Copilot may retain harness-native output,
  request, credit, and checkpoint counters as explicitly non-exact metadata.

## Rejected Surface

- Treating a model name containing `fast` as proof of fast service mode.
- Treating Anthropic Priority Tier and Anthropic Fast mode as the same feature.
- Mapping Codex `priority` directly to an API Priority Tier price.
- Inheriting a parent Codex service tier into a child rollout that does not
  record its own tier.
- Reporting character estimates, divided session totals, inferred costs, or
  embedded provider costs as exact request telemetry.
- Treating Cursor file mtime, transcript content, Grok context snapshots,
  Copilot VS Code request counters, or Copilot CLI output/checkpoint counters as
  exact usage or cost telemetry.
- Claiming parity with every upstream CodeBurn provider from a registry count.

## Guard-Only Future

- Any future estimate or provider-reported cost for Cursor Agent, Kiro, Grok,
  or GitHub Copilot
  requires a separate measurement contract before it can join exact usage
  totals; observed-only metadata remains excluded from those totals.
- Network and RPC sources require separate authority, privacy, retry, and
  snapshot semantics.
- Provider-reported costs may be retained as evidence only after a separate raw
  versus recomputed cost contract is designed.

## Design Laws

1. `agent`, billing `provider`, raw `service_tier`, and canonical
   `service_mode` are distinct dimensions.
2. Price from normalized token buckets and the selected pricing catalog; do not
   trust an embedded total merely because the source exposes one.
3. Missing or unrecognized mode metadata fails open for ingestion but closed
   for premium pricing: record `unknown`, price at the standard rate only when
   the provider/model tariff permits that fallback.
4. One corrupt provider or source must not erase usage from other providers.
5. A derivation change that adds or changes a stored dimension invalidates
   source fingerprints and forces one reimport.

## Falsifier Roster

- Claude events with `usage.speed=fast`, `standard`, missing, and invalid values
  remain four distinguishable inputs and only the first receives fast pricing.
- Claude `usage.service_tier=priority` with `usage.speed=standard` stays standard
  speed.
- Standard and fast `claude-opus-5` requests price identically to their
  corresponding `claude-opus-4-8` requests.
- The first observed fast request is priced only from its recorded cache/input
  buckets; surrounding requests do not invent a cache invalidation.
- Codex priority/default transitions remain attached to the correct turns.
- A forked Codex child without a tier never inherits the parent's fast mode.
- SQLite and ClickHouse round trips preserve agent, raw tier, and service mode.
- A model id containing `fast` without explicit speed telemetry remains
  `unknown`.
- Every admitted exact-usage harness has a discovery fixture, a token-semantics
  fixture, a malformed-input fixture, and an unpriced-model check. Every
  observed-only harness instead has a zero-usage invariant and provenance
  fixture.

## Implementation Seals

- Slice: service mode and representative multi-harness adapters
- Source/spec: `lib/ingest`, `lib/core`, `lib/storage`, `lib/dashboard.js`,
  `public/index.html`
- Boundary: exact local telemetry plus explicitly labelled observed-only Cursor
  Agent/Grok metadata; estimates, network, and RPC sources remain rejected
- Required evidence: focused parser/pricing/storage/dashboard tests, full
  `node --test`, intended diff review, and adversary verdict
