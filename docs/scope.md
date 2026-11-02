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

The supplied target rules permit HTTP/HTTPS on ports 80/443 and every URL path, including private IPv4 and unique-local IPv6 answers for those hosts. Other ports and protocols require explicit configuration for active testing. Unlisted research destinations retain DNS pinning and restricted-address checks; reaching a private or loopback address requires an appropriate network grant or owner review. Direct IP targets require a matching network grant for active testing.

With scope management off, target host, port, path, exclusion and network boundaries are not enforced. Saved target rules and exclusions remain inactive until scope management is enabled again. DNS answers are still validated and pinned to each connection. Credential host bindings, action-effect reviews, request budgets, service destination controls and worker isolation remain active. The agent receives the current enforcement state in its instructions.

The enabled setting and target rules persist across restarts. Existing engagements retain saved targets, service rules and enforcement; older scopes without an `enabled` field remain enforced. Only newly created profiles start off. **Insert course targets** restores the three target rules in the editor while retaining other valid draft settings, including the switch, service endpoints and custom network grants. Empty targets prefill the same course draft. Draft edits take effect only after Apply succeeds.

Configured model API roots are authorized automatically for model traffic, including explicitly declared auxiliary roots and private gateways. They do not become assessment targets. Loopback providers must be explicitly configured as loopback endpoints; public names resolving to loopback still require review.

In action reviews, **Always allow all calls to HOST** authorizes that exact hostname or IP across tools, chats, subagents, paths, methods and ports in the current engagement. It persists across restarts until revoked. Manage these entries directly under **Manage destination allowances**, or revoke them under **Saved allowances**. This explicit owner override can expand the current network scope, including an excluded host. It never grants access to unrelated hosts. Filesystem permissions and action-effect approvals remain independent; their review cards identify the remaining restriction.

**Allow once** and **Always allow** retain their narrower exact-operation meaning. All automatic decisions and owner overrides are recorded in the engagement trajectory.

The optional tool setup reminder can be hidden in the chat. Tool setup remains available under **Plugins**, where the reminder can also be restored. Hiding it does not install, disable or reconfigure any tool.
