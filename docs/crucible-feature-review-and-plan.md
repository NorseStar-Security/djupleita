# Crucible feature review and Djupleita implementation plan

Reviewed 1 November 2026 using the private `aussinfosec/crucible` repository at [commit 3bfb72eea877](https://github.com/aussinfosec/crucible/commit/3bfb72eea87706bc4ce986cab43c14711d0ca2f5). Pull request status below reflects the review, rather than a commitment that open work will merge. This is a proposed implementation plan; no runtime changes are included.

Djupleita should adopt Crucible's approach to assessment quality: establish that the environment works, account for what was actually tested, preserve unfinished hypotheses, and require independent evidence before reporting a finding. Djupleita already supplies the scope, policy, transport, identity, evidence and subagent foundations. The greatest value comes from adding a durable assessment workflow to those foundations.

The first delivery should combine run records and scorecards with session readiness. Follow with findings and validation, then systematic coverage and resumable leads. Broadening into every Crucible target mode would spread the work too thin before this common workflow exists.

## Crucible capabilities and relevance

The [Crucible README at the reviewed commit](https://github.com/aussinfosec/crucible/blob/3bfb72eea87706bc4ce986cab43c14711d0ca2f5/README.md) describes a discovery, proof and reporting pipeline. The following comparison combines that documentation with selected implementations and tests. It does not establish real-target effectiveness or containment through execution.

| Capability | What Crucible provides | Djupleita today | Recommended treatment |
| --- | --- | --- | --- |
| Discovery and assessment modes | CVE reproduction, free-text vulnerability validation, repo/org, library, webapp, binary, web3, mobile, infrastructure, variants and patch diffs | Brokered web testing, passive/CLI recon, ffuf, REA/Ghidra and a shared frontier | Prioritize authenticated web/API assessments and validation of REA leads. Add other modes independently after the common workflow. |
| Structured assessment runs | Stages, progress, caps, stop/resume, artifacts and per-agent usage | Chats, subagents and durable goals, with engagement enforcement and trajectories | Add an explicit run and checkpoint model. A goal's completion must not imply that all planned testing completed. |
| Session reliability | Login recordings, renewal, paired session checks, readiness prerequisites and recovery prompts | Keychain identities and separate browser contexts; no assessment-level session health lifecycle | High priority. Verify each participating identity and distinguish an expired session from an authorization result. |
| Surface quality | Browser/API capture, OpenAPI/HAR/GraphQL inputs, JavaScript/router discovery and catch-all classification | HTML/browser/recon discoveries, URL templates and identity-aware crawl deduplication | Extend the frontier with method, input schema, operation, provenance and route confidence. |
| Coverage and follow-up | Route/focus applicability, feature dossiers, identity matrices, bounded hypotheses and an evidence-preserving lead pool | Ranking and crawl saturation; individual A/B/anonymous read comparisons | High priority. Record which security questions were tested, blocked or left open. |
| Controlled workflows | Plans and guarded walks through application workflows, with limits on test objects and cleanup | HTTP/browser writes use action review; automatic authz replay deliberately permits read methods only | Add explicit scenarios with ownership and reset/cleanup contracts before automated mutation comparisons. |
| Proof and review | Replay or PoC execution, negative controls, runtime evidence gates, Judge and independent Reviewer | Evidence blobs, graph states and authz candidates; trusted assertion support in the authz service | Create first-class findings and deterministic validators. Keep the effect-policy judge separate from the finding validator. |
| Reports and triage | Platform drafts, severity suggestions, duplicate checks, triager review and reproduction packages | RAGE graph export, trajectories, OTLP and course audit delivery | Add findings, reproducible evidence packages and an owner-reviewed report workflow. |
| Campaigns and economics | Multiple waves, root-cause catalogue, budget reservations and program spend history | Shared request/time/rate/concurrency limits; offline ranking studies | Add durable run accounting and reservations before batch or multi-wave automation. |
| Program policy | Read-only HackerOne scope sync, policy extraction with quotations, review and enforceable scan profiles | Manually configured target/service scope and effect rules | Useful optional integration for bounty work; less urgent for course and consulting engagements. |
| Operational feedback | Offline scorecards, watchdog rules, benchmark suites and miss analysis | Detailed trajectories, dependency checks and focused tests; learning currently tunes crawl weights | Adopt local diagnostics and deterministic evaluation first. Keep paid model benchmarks separate from release checks. |

## Recent merged changes worth adopting

These are confirmed merged changes, with priority reflecting Djupleita's needs.

| Crucible change | What is new | Djupleita implication |
| --- | --- | --- |
| [Run scorecards and regression detection, PR 160](https://github.com/aussinfosec/crucible/pull/160) | Offline metrics for session health, rendering, probe depth, applied coverage, firewall blocks, open reasons, spend, findings and traffic violations; comparisons with prior runs and a rolling baseline | Start here. Use existing evidence and trajectories to make incomplete work and regressions visible. Missing metrics must remain unknown. |
| [Readiness gate, PR 152](https://github.com/aussinfosec/crucible/pull/152) | Checks browser rendering and the owner session before probes spend; pauses or stops on failed prerequisites; records explicit waivers | Require readiness per capability and identity. API-only runs should have API prerequisites. Test mode should terminate as blocked instead of waiting for an operator. |
| [Session-ending request protection, PR 154](https://github.com/aussinfosec/crucible/pull/154) | Protects the scan session against logout/revocation requests, including calls initiated by page scripts; distinguishes application traffic in audits | Extend broker-level route semantics to background requests. A click review alone cannot protect an authenticated browser session. |
| [Watchdog, PR 150](https://github.com/aussinfosec/crucible/pull/150), and [additional rules, PR 159](https://github.com/aussinfosec/crucible/pull/159) | Detects stalled traffic, rendering failures, shallow probes, open leads, session loss, traffic violations and low coverage after firewall stops | Surface deduplicated local issues with evidence and a remedy. Start with operator-visible diagnostics; external issue filing is a separate opt-in action. |
| [Lead backlog, PR 142](https://github.com/aussinfosec/crucible/pull/142), and [lead-aware resume, PR 144](https://github.com/aussinfosec/crucible/pull/144) | Preserves distinct reasons behind a lead, tracks which were tested, retains backlog after one reason yields a finding, and avoids repeating finished phases on resume | Separate crawl visitation from hypothesis completion. A cap leaves work open; one finding does not exhaust a feature. |
| [Infrastructure verdict gates, PR 139](https://github.com/aussinfosec/crucible/pull/139), and [harness reliability, PR 138](https://github.com/aussinfosec/crucible/pull/138) | Separates build, runtime, reachability and timeout failures from exploit outcomes; requires evidence of crossing a claimed privilege boundary | Model execution status and security verdict separately. A broken test environment cannot disprove a vulnerability. |
| [Campaign correctness, PR 137](https://github.com/aussinfosec/crucible/pull/137) | Failed waves stay failed, failed waves do not establish saturation, stop reaches hung processes, and failed validation does not overwrite a confirmation | Make lifecycle transitions explicit and test cancellation, restart and aggregate status. |
| [Feature investigator, PR 99](https://github.com/aussinfosec/crucible/pull/99) | Builds feature dossiers and authorization matrices, then runs a bounded hypothesis loop across related routes and identities | Expand A/B checks into feature-level authorization testing after ownership tracking and scenario cleanup exist. |
| [Proof correctness and budget reservations, PR 103](https://github.com/aussinfosec/crucible/pull/103) | Tightens the path from evidence to report and reserves batch validation budgets in advance | Reserve validation capacity when planning discovery. Draft only from the reviewed finding state. |
| [Shared traffic governor, PR 105](https://github.com/aussinfosec/crucible/pull/105) | Enforces program rate and concurrency across browser and tool traffic | Preserve Djupleita's shared broker budgets, and extend them with per-host/program constraints when adding program profiles. |

Crucible's [October miss analysis](https://github.com/aussinfosec/crucible/blob/3bfb72eea87706bc4ce986cab43c14711d0ca2f5/docs/miss-analysis-2026-10.md) distinguishes undiscovered routes, unattempted work, prematurely stopped testing and detected issues that did not reach counted proof. That distinction is useful for Djupleita's evaluation design. More agents or requests alone would not address each failure class.

## Upcoming features to track separately

| Open PR at review time | Idea | Implementation decision |
| --- | --- | --- |
| [Test families per input, PR 148](https://github.com/aussinfosec/crucible/pull/148) | Requires applicable input/test-family cells to cite executed tests, blockers or reasons for inapplicability before a probe finishes | Adopt the completion contract in the coverage phase. Bound it by the approved run budget; incomplete cells remain open. Avoid measuring quality by request count alone. |
| [Changes and leads across scans, PR 153](https://github.com/aussinfosec/crucible/pull/153) | Prioritizes new/changed routes and bundles and carries unfinished lead reasons into a new scan | Add after durable leads and surface snapshots. Prioritization must preserve scope, freshness checks and the remaining coverage plan. |
| [OAuth client credentials and Postman, PR 155](https://github.com/aussinfosec/crucible/pull/155) | API descriptions and OAuth identities with token renewal | Valuable API extension, but the PR describes transport/replay gaps. Djupleita needs one complete identity path across HTTP, comparisons and validation before claiming support. |
| [Watchdog diagnosis bundles, PR 170](https://github.com/aussinfosec/crucible/pull/170) | Builds bounded, redacted timelines around operational problems | Fit to local trajectory/evidence pointers. Generate bundles on demand, with explicit export. |
| [Watchdog noise controls, PR 183](https://github.com/aussinfosec/crucible/pull/183) | Separates evaluation activity from operator runs and rechecks CI problems before filing | Give each run an explicit purpose and namespace diagnostics by run. Evaluation fixtures must not create operator alerts or external messages. |
| [Recency and responsiveness ranking, PR 184](https://github.com/aussinfosec/crucible/pull/184) | Reduces repeated hunting without a rescan reason and incorporates program response history | Defer until there is real program history. Prefer authorized scope, coverage gaps and observed changes over bounty-oriented ranking in the first version. |

## Integration with the existing code

Use native TypeScript services and Cordis bundles. Reuse Crucible's workflow ideas through this project's own interfaces. The existing DSH agent loop can remain unchanged.

| Existing implementation | Extension point |
| --- | --- |
| [Shared contracts](../packages/contracts/src/index.ts) | Versioned run, coverage, lead, finding, validation and session-health records. |
| [Engagement service](../packages/engagement/src/index.ts) | Persisted usage and reservations across chats, child agents and restarts. Current request counters are process-local. |
| [Runtime](../packages/dsh-plugin/src/runtime.ts) and [tool registration](../packages/dsh-plugin/src/index.ts) | Compose run services, register typed tools/effect descriptors, record lifecycle and provider usage events. |
| [Owner RPC](../packages/dsh-plugin/src/rpc.ts) and [review service](../packages/dsh-plugin/src/review.ts) | Owner-only run starts, waivers, cap changes, session replacement, promotion and export. |
| [HTTP broker](../packages/http/src/index.ts) and [browser](../packages/browser/src/index.ts) | Session proofs, background-request protection, request outcomes and traffic roles. Keep DNS pinning, redirects, identity binding and broker enforcement. |
| [Crawl frontier](../packages/crawl/src/index.ts) | Rich surface records and durable queue state. Its current queued/visited/template state lives in memory. |
| [Authz service](../packages/authz/src/index.ts) | Structured response comparisons, identity matrices and trusted ownership verifiers. The runtime currently creates this service per call, so verifier registration needs an engagement-owned lifecycle and an explicit trusted invocation path. |
| [Evidence and trajectories](../packages/trajectory/src/index.ts) | Existing redacted, content-addressed evidence and hash-linked records become the proof substrate. |
| [Evidence graph](../packages/graph/src/index.ts) | Link findings to resources, identities and proof. RAGE export currently declares zero findings; add tested finding interchange when the finding model exists. |
| [Learning service](../packages/learning/src/index.ts) | Reuse dataset provenance and split discipline. Keep ranking optimization separate from proof validity and policy. |
| [Pentest panel](../packages/ui/src/client/Panel.tsx) | Add paginated run, coverage, findings and diagnostics views. Preserve existing bounded trajectory and graph inspection. |

Add `packages/runs` for run state, checkpoints, reservations, coverage and leads; `packages/findings` for immutable finding revisions and proof state; and `packages/validation` for trusted replay/control implementations. Add reporting within the findings package initially. Expose these through optional assessment and validation Cordis bundles using the existing plugin/configuration conventions.

Keep run state below the engagement's private `.pentest` root. Store evidence once and reference it by ID/hash. A run binds its scope/policy revision, tool versions, selected models and parent/child sessions. A checkpoint records completed work and pending reasons independently of the chat transcript.

Suggested record relationships:

```text
Engagement -> Run -> Surface snapshot -> Coverage cells -> Lead reasons
                 -> Session health per identity
                 -> Usage and validation reservations
                 -> Finding -> Validation attempts -> Review -> Report revision
```

Keep execution states such as `running`, `paused`, `completed`, `failed` and `cancelled` separate from finding verdicts such as `candidate`, `inconclusive`, `rejected` and `verified`. A validation attempt adds evidence and a new assessment; it never erases the historical proof behind an earlier result.

## Phased implementation

Estimates are engineering effort for one engineer familiar with the repository, including focused tests and UI integration. They are planning ranges, not measured delivery dates. The core sequence totals approximately 22–34 engineering days, with integration contingency making 5–8 weeks a reasonable initial allowance. Optional integrations follow separately.

### Phase 1 Run records and scorecards

**Effort: 3–5 days.** Establish versioned records and durable transitions in `packages/runs`, then add an offline scorecard over existing evidence and new typed lifecycle events. Capture attempted/completed/blocked work, request usage, render outcomes, stop reasons, session evidence where available, and open work. Unsupported metrics stay `null` with a reason.

Add model-usage accounting for all run-owned model calls, including children and policy judgments. Snapshot pricing inputs and distinguish estimated, reserved and settled costs. If the pinned Harness lacks sufficient usage hooks, document the missing hook and persist any necessary upstream integration as a reviewed `patches/` patch. Missing usage cannot count as zero spend or satisfy a hard dollar budget. Enforce request/time budgets independently.

**Acceptance:** a run survives restart with its counters and stop reason intact; replaying the same events yields the same scorecard; missing observations remain unknown; concurrent reservations cannot overbook a cap; no model or target call is needed to build a scorecard. Do not establish a cross-target regression baseline until runs have compatible scope, test plan, tools and model configuration.

### Phase 2 Readiness and authenticated session health

**Effort: 4–6 days.** Add `unknown`, `verified`, `signed-out`, `expired` and `blocked` session states per identity. Use bounded paired authenticated/anonymous checks against operator-selected protected resources through the broker. Record evidence and a validity interval; cookie presence and HTTP 200 alone do not prove authentication.

Gate automated probes on the capabilities they need: usable browser output for browser work, a working API for API work, and proven identities for authenticated comparisons. Pause for repair through the existing owner review surface. Make waivers specific, revision-bound and visible in coverage. Session replacement invalidates affected checkpoints and pending validation assumptions. Add broker-level protection for logout/revocation routes, including script-triggered requests, with a distinct reviewed path for intentional session tests.

**Acceptance:** a 200 login page, SSO bounce, expired token, role denial and working session classify correctly in local fixtures; one identity's state cannot substitute for another's; background logout requests receive protection; target or policy changes invalidate stale readiness; repair resumes pending work without duplicating completed probes. No interactive pause can hang an evaluation run.

**First useful release:** Phases 1 and 2, approximately 7–11 engineering days, give operators a trustworthy account of whether an assessment could run and what it accomplished.

### Phase 3 Findings and evidence-based validation

**Effort: 5–8 days.** Introduce a finding record with affected resource, identity/ownership context, hypothesis, declared success condition, evidence references, preconditions, severity rationale and validation history. Keep a candidate separate from observed impact.

Implement the first validators for read-only authorization failures and reproducible HTTP observations. Each replay uses identity references resolved at execution time, existing scope/effect checks and a declared negative control. A trusted verifier checks the observable condition. An optional separate review context may challenge or downgrade the result; it cannot promote a finding without the verifier's evidence. This is distinct from `SelectedModelJudge`, which assesses action effects.

Record build failure, missing dependency, target unreachability, session loss, cancellation and timeout as execution failures with an inconclusive result. Add local PoC execution only through a separately designed confined adapter; do not treat the existing REA analysis workspace as an arbitrary exploit-execution sandbox.

**Acceptance:** identical successful A/B responses remain candidates without ownership proof; a control containing the same claimed signal refuses confirmation; failed prerequisites yield inconclusive results; model text cannot manufacture verifier output; changed inputs invalidate an approval; verification cannot outlive its supporting evidence. Extend graph/RAGE tests to round-trip supported findings without weakening existing edge states.

### Phase 4 Coverage contracts and durable lead follow-up

**Effort: 6–9 days.** Persist surface snapshots and a coverage matrix keyed by method, route template, identity context, input/GraphQL operation and test family. Allow `planned`, `tested`, `not-applicable`, `blocked` and `open` cells. Every terminal cell cites request/evidence IDs or a specific reason.

Import OpenAPI and HAR first; add attributed JavaScript/router and GraphQL discovery incrementally. Imported files are untrusted observations. Strip credentials, bound parsing, and pass all discovered destinations through existing scope checks. Distinguish source-mentioned routes, observed application calls, live responses, catch-all responses and authenticated resources.

Persist lead reasons independently from their deduplicated route/class key. A finding may close one reason while leaving others open. Reserve explicit request, time and model capacity for follow-up and validation. On resume, recheck current scope, policy, session health and prerequisite evidence before dispatch. Prioritize observed changes and carried leads within the remaining plan; do not turn prior coverage into a permanent exemption from testing.

**Acceptance:** restart retains pending reasons; budget/time exhaustion never becomes `tested` or `exhausted`; a new concrete reason can reopen a lead within bounded retry limits; a duplicate reason cannot create an infinite loop; a caught-all SPA route is not evidence of a live API; third-party bundle URLs do not widen scope; completing a probe requires cited tests or explicit blockers. A failed wave cannot establish coverage saturation.

### Phase 5 Reports and bounded campaigns

**Effort: 4–6 days.** Add a findings inbox and a report draft generated from a reviewed finding revision. Produce Markdown and a reproduction package with redacted requests, identity placeholders, prerequisite/cleanup instructions, evidence hashes and validation outcomes. Include uncertainty and suggested severity without inventing unsupported impact.

Deduplicate within the engagement using root cause, resource and proof context; preserve genuinely different mechanisms on the same endpoint. Add bounded campaign waves only after checkpointing and reservations work. Each wave consumes approved scope and budget and records why remaining work continues or stops.

**Acceptance:** only the reviewed verified revision enters a confirmed report; credential values cannot enter reproduction commands or packages; an inconclusive rerun preserves earlier evidence and creates an explicit review issue; cancellation stops child dispatch; rejected/failed waves do not appear completed. Export and submission remain explicit owner actions.

### Optional integrations after the core workflow

- **Program scope and policy, 5–8 days initially:** begin with file import and a read-only HackerOne adapter. Preserve policy text hashes, quotations and review history. Activate rules through the owner connection; unknown conditions block the affected automated plan. Required headers, test windows, path exclusions, rate and concurrency constraints need broker-level enforcement. A scope refresh may propose a change but cannot silently authorize new targets.
- **OAuth and Postman, 4–7 days:** implement token acquisition/refresh with Keychain secrets, independently scoped token endpoints and complete HTTP/authz/validation coverage. Ignore collection scripts and automatic external references. Do not inherit another identity's API key during token substitution.
- **Workflow mutation scenarios, 5–8 days:** add owned test-object inventories, declared operations, checkpoints and verified cleanup. Keep automatic mutation replay disabled until these contracts pass. Business-logic testing across roles then becomes a useful extension of the existing authz service.
- **REA validation, variants and patch diffs:** add artifact-version and provenance contracts to the common finding/validation pipeline. Establish a confined execution backend before automatic PoC runs. Estimate each supported target type after that backend is specified.

## Evaluation and release checks

Use deterministic local fixtures and scripted model responses for the core acceptance suite. Cover expired sessions, login pages returning 200, SSO, catch-all SPAs, scope changes, WAF challenges, application rate limits, redirected credential delivery, two owned objects, missing controls, interrupted writes and restart/cancellation. Newly added public examples use `example.test` and generated credentials.

Extend the relevant existing suites: `tests/trajectory.test.ts`, `tests/inspection.test.ts`, `tests/http.test.ts`, `tests/browser.test.ts`, `tests/scope.test.ts`, `tests/policy.test.ts`, `tests/crawl-authz.test.ts`, `tests/graph.test.ts`, `tests/orchestration.test.ts`, `tests/model-egress.test.ts`, `tests/ui-reviews.test.ts`, `tests/ui-polling.test.ts` and `packages/dsh-plugin/src/integration.test.ts`. Add focused run/checkpoint, readiness, finding-verifier, coverage, report and reservation tests as those services appear.

Run `pnpm typecheck`, `pnpm build` and the affected Vitest files for implementation changes. Execute loopback tests on the host if sandbox listening is denied. Preserve the existing course audit path and run `tests/course-audit.test.ts` for changes to shared trajectory/export behavior; worker changes additionally require its `npm test` and `npm run typecheck`. No Cloudflare deployment is part of this plan.

Evaluate the new workflow against the current Djupleita baseline with the same fixtures, scope and budgets. Track readiness success, correctly verified findings, false confirmations, unfinished reasons, coverage with evidence, restart duplication, and usage with known cost provenance. Attribute each miss to discovery, selection, execution, proof or infrastructure. Keep blocked fixtures visible as a separate denominator rather than silently improving recall by dropping them.

Paid live-model evaluation is a separately authorized experiment, never a release check. Reuse the learning package's immutable dataset hashes and separated splits, but do not generalize its offline crawl-ranking results into a claim of improved penetration testing.

## Boundaries and deferred work

Preserve DNS pinning, purpose-specific service scope, host-bound secrets, raw-input grant binding, revision invalidation and owner-only settings. Imported policies, source comments, API descriptions and tool outputs remain untrusted data. New subagents inherit the same controls and shared budgets.

Diagnostics should remain local by default. Crucible's automatic GitHub issue filing, periodic program sync and broader account/registration workflows are independent product choices. Djupleita should expose external writes and automated account changes only through explicitly requested integrations. Application-owned traffic can be labelled separately without relaxing scope or treating its requests as permission to probe another host.

Keep runtime evidence, source-derived assessment notes, private account data and generated diagnostic bundles out of Git. Screenshots for publication require the existing visual/OCR review and secret guard. New upstream behavior must be persisted under `patches/` against the pinned dependency.

Defer broad web3/mobile/cloud scanners, arbitrary exploit builders, unbounded self-improvement and a replacement dashboard. The common assessment workflow should first demonstrate reliable authenticated testing, reproducible findings and useful coverage in Djupleita's current web/API and REA workflows.
