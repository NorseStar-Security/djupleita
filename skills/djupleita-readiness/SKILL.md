---
name: djupleita-readiness
description: Establish live target and session readiness before Djupleita security tests, including anonymous negative controls and browser rendering when required.
---

The owner configures a known URL, a non-secret content marker, an optional registered identity, a freshness interval, and whether browser rendering is required in Pentest → Assessment. Do not choose a marker yourself to make a failing check pass.

Call `pentest_assessment` operation `readiness` with the joined run ID. The broker checks a successful response at the expected URL with the expected marker. Authenticated checks additionally request the same URL anonymously; the protected marker must be absent. A cookie, a login form or HTTP 200 alone does not establish an authenticated session.

When browser rendering is required, first pass the HTTP check, then use `pentest_browser` to navigate to that URL with the same identity. The trusted adapter records a DOM observation; the rendered text must contain the owner marker. Inspect the scorecard to confirm that readiness passed. Browser evidence does not establish JavaScript coverage or application correctness.

401/403 responses or a detected login page from an authenticated request invalidate readiness conservatively. An expected denial while testing another identity can therefore require another readiness check. Configuration changes, identity changes, expiry and process restart also require a fresh check. Do not count transport, DNS, browser launch, missing identity or login failures as evidence that a security control passed.

Session-ending requests, including page-script GET requests to logout or revocation endpoints, require owner action review. Keep session destruction out of ordinary discovery. An intentional session test needs a stated objective and the normal review decision; no prompt or skill bypasses the broker.
