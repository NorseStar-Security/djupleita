# Assessment workflow and proof validation

Djupleita includes two optional plugin bundles and five bundled skills based on the [Crucible feature review](crucible-feature-review-and-plan.md). These are native distribution extensions; they do not install or execute Crucible. The root development `AGENTS.md` remains development guidance. Assessment instructions are contributed to the live agent prompt when the Assessment bundle is enabled.

The Assessment workflow bundle adds `pentest_assessment`, `pentest_skill`, native DSH skill discovery and the workflow prompt. The Finding validation bundle adds `pentest_validate`. On the next normal launch, profile preparation introduces these bundles while preserving existing model settings and previously disabled bundles. They can be disabled independently in the plugin manager. Durable storage and the HTTP safeguards belong to the engagement core.

## Use

1. Ask the assistant to load `djupleita-assessment` and prepare a bounded plan. It should use actual authorized URLs and registered identity references. Alternatively, use **Pentest → Assessment → Start a run** and edit the example JSON before starting.
2. Select the run in Assessment. Configure a known readiness URL, a non-secret expected text marker and, when applicable, the identity that can see it. Enable rendered browser content for web interfaces that need it. The live HTTP check also tests anonymous access to the same protected content. A login form or HTTP 200 alone is insufficient.
3. Install object authorization assertions in the same form, using the example below as a shape. The owning identity and unauthorized identity must differ. The negative control URL must be distinct and on the same origin.
4. Ask the assistant to run readiness and then the declared tests. When rendering is required, navigate with `pentest_browser` using the same identity after the HTTP check. Test attempts use the existing scope, policy, DNS, credential, rate, concurrency and evidence services.
5. Inspect finding evidence in Assessment. An independent owner review can accept a current deterministic proof or reject it with a reason. Export Markdown or the JSON evidence package from the panel. Export does not submit or publish anything.

```json
[
  {
    "id": "object-boundary",
    "title": "Other tenant reads an owner object",
    "url": "https://app.example.test/objects/1",
    "ownerIdentityId": "11111111-1111-4111-8111-111111111111",
    "otherIdentityId": "22222222-2222-4222-8222-222222222222",
    "jsonPointer": "/id",
    "expectedValue": "owned-fixture-object",
    "negativeControlUrl": "https://app.example.test/objects/0"
  }
]
```

Replace these synthetic identity IDs with registered references. Omit `otherIdentityId` to test anonymous access. No credentials belong in this JSON. The owner assertion defines the expected ownership boundary; it is not inferred from matching response sizes. The validator currently supports a string value at a JSON Pointer and GET requests only.

## Implemented behavior

- **Runs and resume:** SQLite retains plans, cells, leads, trusted assertions, the latest readiness check and finding verdicts. State writes have a hash-linked audit record checked on reopen. An active run recovered after process exit becomes paused. The owner resumes it; readiness must be repeated. Finished coverage and the unresolved backlog remain available.
- **Readiness:** checks are bound to scope, policy, plugin configuration, identity metadata and the owner contract, with a bounded freshness interval. An authenticated 401/403 or detected login page invalidates readiness conservatively. A legitimate denial during a negative test may therefore require another readiness check. Browser readiness uses retained DOM evidence and verifies its digest.
- **Budgets and sessions:** run limits are shared across joined sessions. Durable child-session lineage inherits the parent's run automatically. Discovery cannot spend the reserved validation attempts. Engagement HTTP request attempts and the original time window persist through restart; restarting is not a budget reset. Pausing or cancelling aborts in-flight brokered requests. Attempts whose outcome was lost in a crash remain explicit and prevent successful completion.
- **Coverage and leads:** cells distinguish tested, open, blocked and owner-waived work. A tested cell requires fresh readiness and retained evidence matching its URL, method and identity. It records an observed test; it does not automatically prove payload correctness or exhaustive input coverage. Only the owner can waive a cell with a reason. Lead keys persist across retries. Completion requires every declared cell tested or owner-waived and every lead resolved or dismissed.
- **Proofs:** the validator checks an owner baseline, unauthorized replay and distinct negative control. Missing proof is inconclusive; access denied after a valid baseline is rejected. Transport, login and budget failures cannot become verified vulnerabilities. Replaying replaces the previous verdict and resets review. Changing assertions invalidates previous proofs. Owner review cannot promote an inconclusive or rejected result.
- **Reports and watchdog:** reports include only current verified findings accepted by the owner, alongside coverage and unresolved leads. Every included blob is checked against its content digest. Scorecards flag readiness, infrastructure failures, unfinished coverage, unresolved leads, budget pressure and missing model usage. Baseline comparison lists regressed/added cells and prior unresolved leads. Model token counts use provider-reported usage at dispatch, including policy judgments attributed to the run; missing usage stays unknown. Dollar cost is explicitly unknown.
- **Session-ending requests:** logout, sign-out and revocation semantics require owner review even for GETs and routed browser scripts. These checks complement the existing effect policy; they do not loosen scope or authorization.

The five skills are [assessment](../skills/djupleita-assessment/SKILL.md), [readiness](../skills/djupleita-readiness/SKILL.md), [coverage](../skills/djupleita-coverage/SKILL.md), [proof](../skills/djupleita-proof/SKILL.md) and [reporting](../skills/djupleita-report/SKILL.md). They are available through native skill discovery when that service is mounted, and through `pentest_skill` in a minimal host.

## Deliberate limits

This implements the web/API workflow and a read-only object authorization validator. It does not implement all Crucible target modes. Other finding families remain leads until their own deterministic validators exist. Coverage is a declared matrix, not automatic proof that every application surface or payload was tested. Compare results with different configurations cautiously.

Campaign waves are driven by the existing agent and subagent tools within an explicit run; there is no unattended scheduler or automated target rescan. Dollar-priced model budgets, arbitrary OAuth/Postman import, external report submission, automated owner login, long-running watchdog notifications, mutation/cleanup fixtures, general injection proof and other target modes remain separate work. No new external service is required by these bundles.

Runtime records and exported assessment evidence can contain engagement details. They stay under the private engagement root or the operator's selected download destination. They are not source documentation and must never be committed. The implementation tests use temporary directories, fake model responses and reserved `example.test` targets; no release check calls a real model or scans an external target.
