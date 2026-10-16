---
kind: upgrade-guide
description: "Course runtime Apply now requires configured action review, mediated operation policy and live local trajectory collection."
---

# Configure mandatory course action review before Apply

English | [中文](guide.zh.md)

## Change

Course runtime drafts without `actionReview`, HTTP operation restrictions or local trajectories can no longer be applied. Existing saved scope does not silently acquire a reviewer or broader target permissions. Every course tool dispatch now requires a durable review receipt; permission presets cannot bypass it. A missing or unloaded mandatory review service denies execution.

## Migration

1. Stop research in Plugins → Network Scope. Rebuild the runtime images after updating this checkout; existing running images are not rewritten.
2. Stage `actionReview` using [review.json](../../../../course/scope-runtime/review.json). Choose an explicit `evaluators[].model`, HTTPS `endpoint` and `credentialRef`; configure that credential on the native host. For TypeSafe use `kind: "jev"` and its System One endpoint. Keep `destructive` and `insufficient_context` rubrics; add other risk dimensions as required. Do not put literal keys in JSON.
3. Add `policy.operations` from [scope.json](../../../../course/scope-runtime/scope.json), review deny paths and budgets, and retain `requireMediatedHttp: true`. Remove raw `ips` grants: they could bypass HTTP inspection. Domain address pins can still reach authorized private HTTP fixtures. Keep infrastructure method/path permissions narrow; they now remain restrictive even when the host is also in `domains`.
4. Load the local trajectory collector and projection, configure its archive identity, then Save and Apply the new revision. Native intake must succeed before the gateway admits a tool. Reviewer keys and SQLite receipts stay in gateway-only volumes.
5. Confirm matching saved/applied revisions, observed action-review and collection readiness, and the isolated trajectory viewer. Test a controlled allowed action and forbidden operation. Missing model, credential, collection or receipt storage must deny rather than fall back to host research. Read the [runtime reference](../../../../course/scope-runtime/README.md#action-review) for limits, retention and extensibility.
