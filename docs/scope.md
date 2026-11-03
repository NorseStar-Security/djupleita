# Target scope and destination allowances

Fresh macOS desktop and Linux web engagements load the course scope from [issue 13](https://github.com/NorseStar-Security/djupleita/issues/13). **Scope management starts OFF** so students can enable it during the course and compare behavior. Open **Plugins → Djupleita · Engagement and identities → Policy**, turn on **Scope management**, then select **Apply scope and policy**. The switch edits the draft; the status above it shows the applied setting. Applying a change cancels existing requests and resets the crawl frontier.

```json
{
  "enabled": false,
  "targets": [
    { "host": "www.prod.norsestar.internal", "schemes": ["http", "https"], "ports": [80, 443], "pathPrefixes": ["/"], "allowPrivateAddresses": true },
    { "host": "*.dev.norsestar.internal", "schemes": ["http", "https"], "ports": [80, 443], "pathPrefixes": ["/"], "allowPrivateAddresses": true },
    { "host": "*.test.norsestar.internal", "schemes": ["http", "https"], "ports": [80, 443], "pathPrefixes": ["/"], "allowPrivateAddresses": true }
  ],
  "exclusions": [],
  "networks": [],
  "services": { "intelligence": [], "model": [], "telemetry": [] }
}
```

When enabled, the only production target authorized for active testing is `www.prod.norsestar.internal`. Dev and test subdomains are also authorized; wildcards cover nested subdomains but not their apex. Unlisted hosts require target authorization for scanning, fuzzing, automatic crawling, credential comparisons and writes. Reachability and discovered links never grant that authorization.

Ordinary bounded HTTP(S) reads, browser navigation and passive research may use unlisted sites to look up CVEs, documentation or exploit blogs. Each redirect is checked again. The HTTP adapter derives access from the request method, body and known destructive or session-ending URL semantics; callers cannot mark a write as research. A GET is not proof of harmlessness, so effect policy and owner reviews still apply. With scope management on, explicit exclusions block both reads and active testing, unless the owner grants an explicit override. Do not add a `*.prod.norsestar.internal` exclusion if the allowed website must remain accessible: exclusions take precedence while enforcement is on.

Native `web_fetch` uses the same engagement checks and request budgets as `pentest_http`, including checks after every redirect. Its text and HTML results keep the native tool's rendering and redaction.

The supplied target rules permit HTTP/HTTPS on ports 80/443 and every URL path, including private IPv4 and unique-local IPv6 answers for those hosts. Other ports and protocols require explicit configuration for active testing. Unlisted research destinations retain DNS pinning and restricted-address checks; reaching a private or loopback address requires an appropriate network grant or owner review. Direct IP targets require a matching network grant for active testing.

With scope management off, target host, port, path, exclusion and network boundaries are not enforced. Saved target rules and exclusions remain inactive until scope management is enabled again. DNS answers are still validated and pinned to each connection. Credential host bindings, action-effect reviews, request budgets, service destination controls and worker isolation remain active. The agent receives the current enforcement state in its instructions.

The enabled setting and target rules persist across restarts. Existing engagements retain saved targets, service rules and enforcement; older scopes without an `enabled` field remain enforced. Only newly created profiles start off. **Insert course targets** restores the three target rules in the editor while retaining other valid draft settings, including the switch, service endpoints and custom network grants. Empty targets prefill the same course draft. Draft edits take effect only after Apply succeeds.

Configured model API roots are authorized automatically for model traffic, including explicitly declared auxiliary roots and private gateways. They do not become assessment targets. Loopback providers must be explicitly configured as loopback endpoints; public names resolving to loopback still require review.

In action reviews, **Always allow all calls to HOST** authorizes that exact hostname or IP across tools, chats, subagents, paths, methods and ports in the current engagement. It persists across restarts until revoked. Manage these entries directly under **Manage destination allowances**, or revoke them under **Saved allowances**. This explicit owner override can expand the current network scope, including an excluded host. It never grants access to unrelated hosts. Filesystem permissions and action-effect approvals remain independent; their review cards identify the remaining restriction.

**Allow once** and **Always allow** retain their narrower exact-operation meaning. All automatic decisions and owner overrides are recorded in the engagement trajectory.

The optional tool setup reminder can be hidden in the chat. Tool setup remains available under **Plugins**, where the reminder can also be restored. Hiding it does not install, disable or reconfigure any tool.

## Action profiles

Open **Plugins → Djupleita · Engagement and identities → Policy → Action profile**. Existing engagements use **Review** until the operator selects **Red team** and applies the settings. The selector edits a draft; the applied status and advanced JSON show the saved configuration. Scope management and the complete engagement-layer switch remain independent.

Red team allows trusted research, bounded managed reconnaissance and new workspace reports by default. Each category can instead require review or be blocked. Existing-file overwrites, deletion and disruption require review, or can be blocked. Explicit operator rules remain available in **Advanced policy JSON**. Profile blocks cannot be released by a saved operation allowance; changing the policy requires the owner settings channel.

Unknown effects in an adapted tool, including general shell commands, go to the session-selected LLM judge by default. It receives the redacted command, operator scope context and effect/destination metadata, has no tool access, and returns deletion, irreversibility and disruption probabilities plus confidence. Application code applies the configured thresholds. In the Red team profile, likely disruption requires review. A failed, malformed, timed-out or low-confidence judgment also requires review. Operators can change **Unknown effects** to **Ask for review** or **Block**. Calls without an execution adapter also go to judgment; they cannot claim a trusted routine-operation classification.

This is a hybrid policy. Scope checks, known effects, profile rules, credential bindings, budgets and managed-worker isolation are code-enforced. LLM judgment is probabilistic; it does not prove arbitrary shell code safe. General shell commands do not have broker-verified destinations. Prefer the managed tools for network operations: their actual connections are checked, including destinations discovered at runtime. The judge cannot grant target scope or override known destructive effects.

Literal `subfinder -d HOST` and `httpx -u URL` / `httpx -l FILE` shell calls with supported display, rate, concurrency and output flags are routed through the pinned managed recon adapter in Red team mode. They do not execute the requested arbitrary binary. Rate and concurrency are capped by engagement budgets; output uses structured JSON records. New output files and input lists must remain within the chat workspace, including symlink resolution, and output creation never overwrites an existing file. Unsupported flags, shell expansions, pipelines and scripts remain unknown effects and go to judgment. The typed `pentest_recon` tool remains the preferred interface. Active probing still needs target scope when scope management is on; passive research may use unlisted non-excluded subjects.

New workspace reports and bounded non-empty native edits can follow the workspace policy. Replacing an existing file with `write`, emptying a file, paths outside the workspace and changes to protected configuration directories keep destructive review. Existing Harness filesystem and sandbox permissions remain active.

## Assessment prompting

The engagement persona frames work as an operator-authorized bug bounty or commissioned assessment. It follows the current objective, including requested bounded active testing, without repeatedly requesting generic authorization. A later operator instruction can change an earlier task-specific passive-only limit; saved engagement restrictions and actual tool decisions still apply. Blocked operations remain blocked while permitted work can continue.

The bundled Assessment skills govern structured runs and formal object-authorization proofs. Their readiness contracts, owner assertions and accepted-finding gates remain intact, and are not presented as prerequisites for every active investigation. Prompting does not add target scope, change action policy, reset a budget or resume a stopped run. The engagement layer supplies the same context to desktop, web and delegated agents; turning the layer off removes it.

## Engagement budget

Policy shows the saved time deadline, remaining time, request usage, request rate and concurrency. The time allowance uses elapsed wall-clock time, including idle time, and survives restarts. An expired engagement blocks network tools before another approval is requested. **Renew time budget** is an authenticated owner action that starts a fresh time allowance; it preserves request usage, scope, credentials, evidence and saved allowances. Renewal is recorded in the trajectory and is unavailable to model tools.

Managed passive reconnaissance uses public research access for its source connections, with exclusions and private-network checks still enforced. Active httpx probing retains target scope. Proxy scope or budget failures are reported as tool failures even when a CLI exits zero; they are never presented as successful empty discovery. Status lists optional intelligence prerequisites, so public enumeration can proceed without a Chaos or PDCP account.

Managed httpx accepts an explicit `targets` URL array, validates every target before launching, and runs the batch under one worker's rate and concurrency limits. Evidence is saved automatically; no intermediate file in protected app state is needed. Public credential-free DNS lookups follow ordinary research access, including exclusions and private-network checks. Credential-backed intelligence APIs retain their service and identity boundaries.
