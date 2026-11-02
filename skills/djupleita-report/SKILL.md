---
name: djupleita-report
description: Review Djupleita run scorecards, compare regressions and prepare redacted reports containing only current deterministic proofs accepted by the owner.
---

Inspect the run summary, finding pages, unresolved leads and coverage pages with `pentest_assessment`. Use `compare` for a prior run. Treat configuration differences, removed cells and incomplete work as limits on baseline conclusions.

The scorecard reports actual request attempts, responses, failures, declared coverage, finding counts and reported model tokens. Provider usage can be absent; cost is unknown. Do not invent dollars, reproduction rates, test depth, or covered attack classes from these counters. A high error count can indicate an unusable target rather than an effective test.

Have the owner review each deterministically verified proof in Pentest → Assessment. The report builder includes only current verified findings accepted there. Candidates, rejected and inconclusive results stay out of the findings section; unresolved leads and coverage limits remain visible. The owner can export redacted Markdown and JSON with checked, content-addressed evidence from the Assessment panel. Do not upload or submit the report without a separate instruction.

State the observed impact, the installed assertion, relevant identities as references, reproduction steps, negative control and evidence IDs. Separate your recommended remediation from demonstrated facts. When the service refuses completion, preserve its reason and use pause or failure; do not describe partial work as saturation or imply that no accepted findings means the application is secure.
