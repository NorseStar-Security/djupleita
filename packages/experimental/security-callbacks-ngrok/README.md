---
description: "Publish a dedicated security callback receiver through a configurable ngrok agent."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-security-callbacks-ngrok

English | [中文](README.zh.md)

## Summary

Publish temporary callback URLs using a running ngrok agent and an HTTPS origin allocated to your account. Choose the agent API address and API budgets in Cordis YAML. The provider creates one dedicated endpoint for the receiver and removes only that endpoint during cleanup. The operator owns ngrok installation, authentication, and network access.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Start an authenticated ngrok agent with its loopback Agent API enabled and no endpoint occupying the chosen public origin. Set `DSH_CALLBACK_PUBLIC_URL` to that allocated HTTPS origin in the Harness launch environment, then apply [examples/ngrok.patch.yml](examples/ngrok.patch.yml) through the normal profile `--patch` option. This worktree overlay references built sibling packages. Installed compositions can mount the three package names instead.

| Field | Default | Meaning |
|---|---|---|
| `agentApi` | `http://127.0.0.1:4040/api` | Loopback ngrok Agent API root |
| `publicUrl` | required | HTTPS origin allocated to the ngrok account |
| `timeoutMs` | `10000` | Deadline per API request, including deletion |
| `maxApiBytes` | `65536` | Maximum API response bytes |

The adapter uses the [ngrok Agent endpoints API](https://ngrok.com/docs/gateway/agent/api), with a random endpoint name, the dedicated local receiver as upstream, traffic inspection disabled, and pooling disabled. It does not expose the Harness UI, start ngrok processes, or put authentication tokens in tool arguments. A failed publication attempts deletion by the generated name; cleanup failures report that the remote endpoint may remain and require checking the agent.

For another service, replace the tunnel row with your own plugin. The [custom overlay](examples/custom.patch.yml) and [provider module](examples/custom-tunnel.mjs) use an externally managed reverse proxy forwarding the configured HTTPS origin to `http://127.0.0.1:8787`. That provider validates the upstream address and acquires no remote resources. Its cleanup leaves the operator’s proxy running; the receiver still revokes paths and stops its local listener. Extend `CallbackTunnel.open` to integrate another management API without changing callback tools.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The [provider](src/index.ts) implements the callback tunnel service, bounds Agent API responses, and attempts compensating deletion after failed creation. Agent API redirects are rejected. Cleanup targets the generated endpoint name, never all endpoints or agent-wide captured traffic.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [HTTP receiver](../security-callbacks/README.md)
- [ngrok provider](../security-callbacks-ngrok/README.md)
- [Callback tools](../security-callbacks-tools/README.md)
- [Tools subsystem](../../../docs/subsystems/tools.md)

<a id="model-experience"></a>
## Model Experience

### Callback workflow

#### What the model sees

The `callbackTunnel` provider contributes no prompt or tool schema. The receiver and tools use its published HTTPS origin in callback results.

#### Token effect

This package adds no prompt tokens directly. Capture budgets bound the evidence returned by the tool consumer.

#### KV Cache effect

No direct token or KV-cache effect. Changing providers can change callback URL values in later tool results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment** — requires a separately authenticated ngrok agent supporting the endpoints API in the receiver’s network namespace. Account permissions and endpoint availability are checked by ngrok on publication.
- **Enforcement** — course runtimes must explicitly allow ngrok operational egress; callback configuration never adds target grants or bypasses the course gateway.
- **Verification** — local Agent API fixtures cover composition and cleanup. A live ngrok account and public callback delivery are not verified by the keyless suite.

<a id="dev-note"></a>
### Dev Note

None.
