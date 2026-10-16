# Agent Note: Course action review and secure default execution

Status: proposed

English | [中文](2026-10-15-course-action-review-and-secure-defaults.zh.md)

## Problem

Destination scope does not authorize every operation on an allowed host. An action against a shared edge proxy can affect other customers even when its hostname belongs to an in-scope application. Browsers, terminals, and arbitrary code must remain usable without treating their destinations or effects as inherently safe.

The Local/Protected choice also mixes execution location with assurance. Selecting an isolated backend does not establish an applied scope policy, a working judge, or complete trajectories. The course needs one default research environment with visible readiness and feature parity, not a safety label that depends on unobserved configuration.

## Proposal

Add extensible action review alongside destination enforcement, and make the isolated Linux runtime the default for course research. Require an applied engagement policy, healthy enforcement, and local trajectory collection before admitting research work. This proposal does not change runtime behavior; implementation and the acceptance checks below remain required.

Keep the [destination enforcement decision](../../implemented/architecture/2026-10-14-course-network-scope.md), the existing [Auto review](../../implemented/feature/2026-08-28-auto-review.md), and its [approval fallback](../../implemented/feature/2026-09-24-auto-review-user-approval-fallback.md) as independent owners. Course action review complements them; it does not replace network isolation or change the general-purpose harness's permission presets. No existing decision is fully superseded or eligible for archival by this proposal.

### Plugin composition and coverage

Define an action-review capability with independently mountable evaluator providers, an aggregation policy, a tool-dispatch consumer, and a trajectory consumer. Initial providers cover deterministic rules and a configurable LLM; add a TypeSafe JEV provider through the same interface. Later plugins can add course-specific risk dimensions without changing the agent loop or every tool adapter.

Use the existing [tool runtime](../../../../packages/core/tools/src/index.ts) pre-execution pipeline and monotonic guards. Every executable agent tool call must enter the course review path before its body: native tools, MCP tools, the outer programmatic tool-calling (PTC) `run_code`, nested `tools.*` calls, subagents, and background/headless entry points. Agentless execution must carry an explicit trusted execution context or be denied. Deterministic hard denials may short-circuit model review, but must still produce an audit decision. Do not inherit Auto review's outer-program exemption or its session-only activation.

The immutable review input binds tool identity, schema, complete arguments, call/parent/session identity, execution environment, and active policy revision. Supply separately sourced human authorization, trusted engagement rules, and relevant state. Treat tool descriptions, page content, tool output, and agent assertions as untrusted evidence, never authority. Missing context, unsupported payloads, or input too large to review produce `unknown`; do not silently truncate an executable payload and then approve it.

A reviewed script can perform many effects without another tool call. Reviewing its text cannot intercept every subprocess, browser request, redirect, service worker, or remote executor. Keep kernel destination enforcement and gateway inspection below tool dispatch. External executors and server-side pivots require independent containment; they do not inherit safety merely because their launching tool passed review.

### Classification and enforcement

Separate extensible risk findings from the final decision. Initial findings cover destructive effects, authorization gaps, shared-infrastructure impact, and insufficient context. Add reckless load, excessive concurrency, sensitive-data exposure, or other course rubrics as independent dimensions. A negative finding means “no issue identified by this evaluator,” not a proof that an action is safe.

The policy combines findings into `allow`, `deny`, or `require_approval`. Deterministic destination, operation, and integrity denials always win; neither a model answer nor human approval can override them. Course policy controls whether an otherwise reviewable exception can reach an instructor approval prompt. Bind any approval to the exact call arguments, policy revision, short expiry, and one execution; never turn it into a broad capability grant.

Require an explicit deployment choice of LLM, JEV, or both, with provider/model and rubric versions recorded. Multiple mandatory evaluators must all satisfy policy; disagreement or uncertainty cannot become an implicit allow. Do not cache authorization across changed arguments, policy, or relevant state. Evaluator errors, cancellation, malformed answers, unavailable mandatory providers, and missing audit acknowledgement prevent execution. Reviewer requests have no tools and cannot recursively authorize themselves.

Keep remote reviewer credentials and authoritative decision storage in trusted management services, outside the research process. Expose only the bounded review protocol, not an arbitrary HTTP relay or configuration mutation API. Redact credentials before remote submission; if redaction removes facts needed for a decision, require a suitable local reviewer or refuse admission. A separately configured reviewer service is operational infrastructure, not an additional research target.

### JEV adapter

TypeSafe documents JEV as a state-plus-typed-questions API with structured answers. Its [introduction](https://docs.typesafe.ai/introduction) recommends decomposing judgments. Ask separate questions about destructive effects, shared-infrastructure impact, missing authorization, and inadequate context, rather than asking one model to declare an action globally safe. Preserve each answer's probability; preserve confidence only where the question type supplies it, following the [confidence documentation](https://docs.typesafe.ai/confidence).

Map these answers into the shared findings contract; deterministic course code owns thresholds and decisions. Validate the response, pin the deployed model version, and calibrate thresholds against course fixtures before enabling automatic admission. Typed output prevents neither semantic mistakes nor unsafe classifications. The [authenticated API](https://docs.typesafe.ai/introduction/quickstart) is an external deployment dependency: this plan does not establish account access, a working integration, performance, or security accuracy.

### Operations below the tool boundary

Extend the gateway policy beyond destination checks to apply hard operation restrictions to both target hosts and infrastructure hosts. Evaluate canonical authority, method, normalized path, and protocol consistently; reject ambiguous encodings and unsupported inspection rather than relying on a raw substring denylist. A target grant must not bypass an infrastructure operation restriction.

Include administrative shutdown and destructive shared-service controls in the initial rules of engagement. Use isolated fixtures for cases such as `/quitquitquit`, never a live provider's control endpoint. HTTP method alone does not establish safety, and body-driven APIs need explicit operation-aware rules where supported. Otherwise report the inspection limitation instead of claiming complete destructive-operation prevention.

Raw IP/CIDR grants can bypass HTTP-level inspection and authorize shared virtual hosts or other protocols. Require separate instructor authorization and a mediated protocol policy where operation controls are mandatory; refuse incompatible grants rather than advertising equivalent protection. Enforce request-rate and concurrency limits at the gateway when one admitted tool can generate many requests. Keep these limits independently extensible from model classification.

### Secure course startup and UI

Default new course GUI and CLI research sessions to the isolated runtime. Apply the same requirement to resumed sessions, subagents, automation, and API admission. Native host management remains the control plane; it must not silently become a research execution fallback. Missing Docker/VM support, a stopped gateway, absent scope, or an unavailable mandatory judge leads to setup or a blocked state, not Local execution.

First-run setup must apply explicit target scope and rules of engagement before enabling research tools. Distinguish edited, saved, applied, and observed-live revisions. Fix stale status responses overwriting newer saved edits as part of this work. Show isolation, active destination policy, action review, and collection health separately; name the backend “Isolated Linux” rather than implying that “Protected” alone establishes readiness. Do not promise unrestricted capabilities when the runtime cannot provide them safely.

Keep unrestricted host execution behind an explicit advanced instructor-controlled action with a clear warning and separate sessions. A course deployment may disable it entirely. Existing Local jobs are not retroactively confined; present a transition choice without silently moving credentials, killing processes, or resuming them on the host. Required course guards cannot be disabled through a permission preset, optional-plugin toggle, or an unload-to-Full-access transition. Unloading or changing required providers closes new admission and invalidates pending approvals until readiness is re-established.

### Mandatory trajectories

Make durable local collection and the GUI trajectory viewer part of the course runtime's required composition, not an optional imported feature. Reuse the [collector](../../../../course/trajectory-collector/README.md) and [viewer](../../../../packages/experimental/trajectory-viewer/README.md), with trusted collection and read APIs outside the research agent's writable environment. Complete protected-runtime archive ingestion and navigation before claiming feature parity. The GUI must show current research sessions and their histories without requiring users to switch to an unrestricted research environment.

Record every admission outcome, evaluator/rubric version, findings, applicable policy revision, approval identity where applicable, latency, and final dispatch outcome. Correlate these with existing tool, session, parent, and runtime identities. Persist a trusted admission record before executing a call; failure to commit it blocks that call. Do not collect hidden chain-of-thought or credentials. Shared namespace network events must retain honest shared attribution unless a tool-specific relationship is actually established.

Provide bounded live polling, pagination, trace trees, and filters for runtime, session, tool, destination, risk, and decision. Display collection lag, gaps, and disconnection explicitly. Preserve replay identities across restarts and test duplicate suppression. Local collection is required; temporary remote-export failure is not a reason to disable research while local durable capacity remains available. Storage exhaustion must be visible and close admission before required history is discarded.

Logfire remains an optional exporter of the local durable stream, outside the research process. Student SSO/enrollment remains a separate, unbuilt deployment requirement owned by the [telemetry enrollment proposal](2026-10-15-course-telemetry-enrollment.md); neither it nor a Logfire secret is a prerequisite for viewing local trajectories.

### Delivery order

1. Complete isolated-runtime feature parity, mandatory local trajectories, saved/applied/live state, and a readiness model. Keep the current startup behavior until fail-closed routing is verified.
2. Implement the action-review capability, deterministic rules, LLM provider, complete tool-dispatch coverage, trusted decision persistence, and instructor exception handling. Reuse existing review infrastructure without inheriting its Full-access policy.
3. Add JEV as a replaceable provider, provider-contract tests, a course risk evaluation corpus, and configurable dimensions such as reckless load. Require actual account-backed verification before advertising JEV as available.
4. Implement gateway operation restrictions and request budgets; prove that direct program/browser traffic cannot evade the supported controls.
5. Switch all course research entry points to isolated-by-default admission, ship migration guidance, and validate the distributed Linux image through the real GUI and CLI. Do not describe the end-to-end requirement as complete after only the tool-review milestone.

## Alternatives considered

**Enable the existing Auto preset.** It provides useful review infrastructure but uses Full-access execution, excludes outer PTC programs, and has different activation, policy, audit, and unload semantics. It cannot serve as mandatory course containment unchanged.

**Use an LLM or JEV as the sole safety boundary.** Both can misjudge effects or lack context. Destination enforcement and hard operation rules must remain authoritative even when a model approves.

**Blanket-deny browsers, code, terminals, and scanners.** This defeats the course's research capabilities without solving destination or operation authorization. Keep the capabilities open within enforceable policy and report unsupported execution honestly.

**Change only the selector default or its label.** This hides missing configuration and feature gaps. Require readiness, feature parity, and no silent fallback before making the course default mandatory.

## Acceptance criteria

- Real GUI and CLI sessions on a clean course image use isolated execution by default. Missing or unapplied scope, failed guards, and unavailable required local storage prevent research execution. Resume, subagents, background jobs, and API entry points cannot fall back to host execution.
- Keyless fixtures exercise native calls, outer and nested PTC calls, MCP browser calls, subagents, and agentless admission. Each attempted executable dispatch has a review record; a denied, cancelled, or failed review leaves the tool body's observable counter unchanged.
- An allowed-host ordinary request succeeds. An out-of-scope host remains denied even when every model says allow. A forbidden administrative action on an allowed host leaves an isolated server's action counter at zero, including attempts from admitted terminal code and a real browser.
- Fixtures cover method changes, encoded/ambiguous paths, target/infrastructure overlap, redirects, raw-IP exceptions, unsupported protocols, and high-rate requests. Tests distinguish supported enforcement from explicitly unsupported body semantics and remote pivots.
- A third-party evaluator plugin adds a reckless-load rule without changing the agent loop or individual tools. Conflict, low certainty, missing context, prompt injection, stale policy revisions, reviewer failure, and attempted plugin removal cannot produce an unauthorized allow.
- Approvals cannot override hard denials, authorize different arguments, survive a policy revision, or execute twice. Concurrent calls and cancellation cannot execute before their individual trusted admission records commit.
- The isolated GUI shows tool calls, decisions, network events, and parent/child trajectories through the trusted reader. Restart/replay retains history without duplicate events. Offline Logfire export preserves local usability and later delivery; collector lag and disk exhaustion are visible and tested.
- Provider contract tests use deterministic responses. A separately authorized real-provider evaluation measures false allows, false denials, uncertainty, latency, and cost on course examples before selecting thresholds; no public destructive endpoint is contacted as a test.

## Risks

Classification is probabilistic, and an apparently ordinary action can have harmful effects unknown to the reviewer. Tool review plus HTTP operation rules is not a universal proof of non-destructive behavior. Arbitrary local processes, opaque protocols, remote pivots, and sandbox escapes require additional controls and explicit limitations.

Per-call review adds latency, cost, provider availability dependencies, and sensitive-context handling. Strict uncertainty and audit rules can block legitimate work; tune rubrics through measured fixtures rather than weakening hard scope rules. Mandatory collection needs retention, access control, capacity planning, and course consent. A student controlling the host or hypervisor can suppress or forge local evidence; this design does not provide attestation.
