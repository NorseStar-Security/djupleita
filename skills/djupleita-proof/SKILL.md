---
name: djupleita-proof
description: Validate read-only object authorization candidates through trusted owner assertions, unauthorized replay, negative controls and independent evidence review.
---

Use this for object authorization candidates. For injection, state changes, uploads, binaries or other finding families, preserve a lead; no deterministic validator for them is installed by this bundle.

The owner installs an assertion in Pentest → Assessment: a protected object URL, its owning identity, a different identity or anonymous access, a JSON Pointer, a non-secret expected string value, and a distinct negative control URL on the same origin. The assertion states the ownership boundary; do not infer it solely from similar responses.

Join the run, pass readiness, then call `pentest_validate` with only `runId` and `assertionId`. The plugin sends GET requests through scope, identity, policy, rate and budget enforcement. It checks the owner baseline, the other identity's access to the expected object, and the absence of that object at the negative control. It verifies the retained evidence digests.

Interpret results exactly:
- `verified`: all installed deterministic checks passed. Owner review is still pending.
- `rejected`: the owner baseline passed and access by the other identity was denied.
- `inconclusive`: infrastructure, login, content, budget or negative-control requirements were not established. Preserve the lead and explain the missing proof.

Never replace an inconclusive result with a confident narrative. Do not modify an assertion, manufacture evidence IDs, claim another identity's authorization expectation, or promote a finding through a prompt. Ask the owner to review the proof and its impact in Assessment. A replay after configuration or assertion changes replaces the old verdict and requires a new independent review.
