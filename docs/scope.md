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

When enabled, the only production target is `www.prod.norsestar.internal`. Dev and test subdomains are also in scope; wildcards cover nested subdomains but not their apex. Every other production host and every destination outside these three rules is out of scope, even if reachable through an allowed system. Do not add a `*.prod.norsestar.internal` exclusion: exclusions take precedence, so that would block the allowed website too. The narrow target allowlist denies other production systems without an exclusion.

The supplied rules permit HTTP/HTTPS on ports 80/443 and every URL path, including private IPv4 and unique-local IPv6 answers for those hosts. Other ports and protocols require explicit configuration. Loopback and other restricted networks require explicit CIDRs when enforcement is on. Direct IP targets also require a matching network grant.

With scope management off, target host, port, path, exclusion and network boundaries are not enforced. DNS answers are still validated and pinned to each connection. Credential host bindings, action-effect reviews, request budgets, service destination controls and worker isolation remain active. Turning enforcement off does not expand the authorized assessment: the agent receives the declared scope and the current enforcement state in its instructions.

The enabled setting and target rules persist across restarts. Existing engagements retain saved targets, service rules and enforcement; older scopes without an `enabled` field remain enforced. Only newly created profiles start off. **Insert course targets** restores the three target rules in the editor while retaining other valid draft settings, including the switch, service endpoints and custom network grants. Empty targets prefill the same course draft. Draft edits take effect only after Apply succeeds.

Configured model API roots are authorized automatically for model traffic, including explicitly declared auxiliary roots and private gateways. They do not become assessment targets. Loopback providers must be explicitly configured as loopback endpoints; public names resolving to loopback still require review.

In action reviews, **Always allow all calls to HOST** authorizes that exact hostname or IP across tools, chats, subagents, paths, methods and ports in the current engagement. It persists across restarts until revoked. Manage these entries directly under **Manage destination allowances**, or revoke them under **Saved allowances**. This explicit owner override can expand the current network scope, including an excluded host. It never grants access to unrelated hosts. Filesystem permissions and action-effect approvals remain independent; their review cards identify the remaining restriction.

**Allow once** and **Always allow** retain their narrower exact-operation meaning. All automatic decisions and owner overrides are recorded in the engagement trajectory.

The optional tool setup reminder can be hidden in the chat. Tool setup remains available under **Plugins**, where the reminder can also be restored. Hiding it does not install, disable or reconfigure any tool.
