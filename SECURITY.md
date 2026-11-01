# Security

Use Djupleita only for authorized assessments. Report vulnerabilities privately through the repository's **Security → Report a vulnerability** interface when available; do not put credentials, engagement evidence, or exploit targets in public issues.

## Prevent credential leaks

GitHub secret scanning and push protection block recognized credentials before the remote accepts a push. The `Secret scan` GitHub Actions check provides an additional Gitleaks scan of every outgoing commit, so a secret added and then deleted in the same push still fails. Scheduled and manual runs scan complete reachable history. The scanner extends the default rules without excluding tests or source directories, redacts its output, and runs a synthetic-secret negative control before each scan. Scanner failures and missing binaries block the operation.

Install the checksum-pinned Gitleaks 8.30.0 binary and activate hooks in each clone:

```sh
node scripts/security/install.mjs
node scripts/security/hooks.mjs
node --test scripts/security/scan.test.mjs
```

The hooks check staged contents before commit, all outgoing commits before push, and filenames in the committed tree. The path guard rejects runtime state, credential stores, environment files, private key containers and unreviewed screenshots even when staged with `git add -f`. `.env.example`, `.env.sample` and `.env.template` are allowed filenames but their contents are still scanned. Screenshots intended for publication belong under `docs/images/` and require visual review; scanners do not recognize secrets rendered as pixels.

The installer verifies official release archive SHA-256 hashes recorded in `configs/gitleaks.lock.json`. Version 8.30.0 is pinned and tested rather than using an unbounded latest release. Local hooks can be bypassed by a contributor, so retain GitHub push protection and the required CI check on `main`. Main-branch protection should require `Secret scan`, enforce it for administrators, and refuse force pushes and branch deletion.

`.gitleaksignore` records only exact historical commit/file/line/rule fingerprints reviewed as translation Git blob hashes or synthetic test fixtures. It is not a baseline for real leaked keys. The one configuration allowlist recognizes the literal environment-variable name `SEC590_LLM_API_KEY`, not its value. Review any new exception individually and rerun negative controls. Inline `gitleaks:allow` comments do not bypass this scanner.

## If a credential is exposed

Revoke or rotate it at the provider first. Removing it from the current file does not revoke it or remove it from history. Preserve the alert, review its use, and coordinate any required history cleanup with maintainers. Never add a real leaked key to the ignore file merely to make a push pass.

## Local assessment data

`.pentest/` contains model keys, engagement scope, identities, browser state, trajectories, and evidence. It stays local. The course receiver and OTLP exporter are disabled until explicitly configured. Configure only an approved collector, a credential bound to that host, and the corresponding telemetry service scope. The app's in-process exporter does not provide isolation from a compromised local operator process. Use a separate instructor-owned deployment when that isolation is required.
