---
name: djupleita-coverage
description: Maintain the declared Djupleita test matrix and durable lead backlog, resume without repeating finished work, and compare a run against its baseline.
---

Inspect `pentest_assessment` sections `cells` and `leads`, following `nextOffset` pages. Each cell records a URL, method, named input, test family and identity. Prioritize changed surfaces and unresolved leads from operation `compare` against a baseline; configuration differences limit comparisons.

Send target traffic only through the installed brokered tools. Record a cell with operation `cover`, a concrete reason, and broker-retained evidence IDs. `tested` requires a matching URL, method and identity observation and fresh readiness. This establishes an observed test, not that a payload was correct or that every possible input was exercised. Explain the actual payload and the result in the reason; retain counterexamples.

Use `blocked` when the test could not run. Use operation `lead` to upsert a stable `key`, a specific summary, a reason (`untested`, `needs-identity`, `needs-owner-assertion`, `infrastructure`, `budget`, or `follow-up`), related cell and evidence IDs. Preserve the key across retries. Mark a lead `resolved` only with an explanation of the resolution, or `dismissed` with its rationale. The owner alone can mark a cell not applicable, with a reason.

After a finding, continue the remaining cells or explicitly pause the run. After a tool failure, record the infrastructure problem and preserve untested work. After a restart, use the existing run and ask the owner to resume; passed cells and leads persist. Completion requires every declared cell tested or owner-waived and every lead resolved or dismissed. Completion is not a claim of universal security coverage.
