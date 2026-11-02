---
name: djupleita-assessment
description: Plan or resume an authorized Djupleita web/API assessment with bounded requests, durable coverage, evidence gates and explicit incomplete outcomes.
---

Inspect `pentest_status` and the available tools. If `pentest_assessment` is absent, enable the Assessment workflow bundle in Plugins before using this workflow.

1. Define the authorized objective and a small plan of surface × method × input × test family × identity cells. Use registered identity IDs; use `anonymous` for public access. Do not put account secrets in a plan.
2. Call `pentest_assessment` operation `plan` with a title, `maxRequests`, `validationReserve` (at least 3), and `cells`. Every request, redirect and browser subresource consumes budget. Leave room for readiness and repeated proof; a three-request proof may need more capacity if there are redirects.
3. Ask the owner to configure the readiness contract and read-only object assertions in Pentest → Assessment. Load `djupleita-readiness` and pass its live checks before interpreting security tests.
4. Load `djupleita-coverage`. Explore the declared cells, retain evidence, and save reasoned leads as work proceeds. Discovery stops at the reserved proof budget. Finding a vulnerability does not complete unrelated cells.
5. Load `djupleita-proof` for candidate authorization findings. Model opinions, equal response sizes and successful statuses are hypotheses. Use only the validator's result as a deterministic proof verdict.
6. Load `djupleita-report`. Keep findings pending until the independent owner reviews their evidence.

Use bounded waves within the declared run. Before a child agent sends target traffic, give it the run ID and require operation `join`; keep all target actions on brokered tools. Inspect the existing cells and leads after compaction or restart. Do not recreate a finished cell merely because its previous conversation text was compacted.

Use operation `stop` with `pause` for a recoverable interruption or `fail` for a failed campaign. Use `complete` only after the service accepts the declared completion contract. Only the owner resumes stopped work. A blocked cell or unresolved lead means incomplete work, even when the request budget is exhausted. Never infer that the target is safe from a completed declared plan.
