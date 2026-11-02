# Target scope and destination allowances

In **Pentest → Policy**, a completely unconfigured scope opens with this editable draft. Replace `example.test` throughout with your authorized domain and choose the host or subtree to exclude. Nothing in the draft is authorized until **Apply scope and policy** succeeds.

```json
{
  "targets": [
    { "host": "example.test", "schemes": ["http", "https"], "ports": [80, 443], "pathPrefixes": ["/"], "allowPrivateAddresses": false },
    { "host": "*.example.test", "schemes": ["http", "https"], "ports": [80, 443], "pathPrefixes": ["/"], "allowPrivateAddresses": false }
  ],
  "exclusions": ["excluded.example.test", "*.excluded.example.test"],
  "networks": [],
  "services": { "intelligence": [], "model": [], "telemetry": [] }
}
```

`example.test` covers the apex. `*.example.test` covers subdomains and does not include the apex. The two exclusion entries together exclude `excluded.example.test` and every descendant; exclusions take precedence over matching target rules. A target must be a complete host-rule object, not a hostname string.

This first template covers HTTP and HTTPS on ports 80 and 443 and all URL paths. Other ports must currently be listed explicitly. The preview explains the draft's boundary; the server validates the submitted scope before applying it. The working reference remains available after configuration. Existing targets, exclusions, network grants and service rules are preserved when the editor opens or the app restarts.

For internal targets, use complete host rules and authorize only the intended network CIDRs. `allowPrivateAddresses` permits private IPv4 and unique-local IPv6 DNS answers for that host. `networks` can authorize other restricted ranges and is required for direct IP targets. For example, a target rule for `192.0.2.10` needs `192.0.2.10/32` in `networks`. A hostname rule, private-address permission and a CIDR perform distinct checks.

Configured model API roots are authorized automatically for model traffic, including explicitly declared auxiliary roots and private gateways. They do not become assessment targets. Loopback providers must be explicitly configured as loopback endpoints; public names resolving to loopback still require review.

In action reviews, **Always allow all calls to HOST** authorizes that exact hostname or IP across tools, chats, subagents, paths, methods and ports in the current engagement. It persists across restarts until revoked. Manage these entries directly under **Manage destination allowances**, or revoke them under **Saved allowances**. This explicit owner override can expand the current network scope, including an excluded host. It never grants access to unrelated hosts. Filesystem permissions and action-effect approvals remain independent; their review cards identify the remaining restriction.

**Allow once** and **Always allow** retain their narrower exact-operation meaning. All automatic decisions and owner overrides are recorded in the engagement trajectory.

The optional tool setup reminder can be hidden in the chat. Tool setup remains available under **Plugins**, where the reminder can also be restored. Hiding it does not install, disable or reconfigure any tool.
