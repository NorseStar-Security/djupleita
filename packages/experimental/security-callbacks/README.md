---
description: "Create temporary HTTP security callbacks and read bounded evidence per session."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-security-callbacks

English | [中文](README.zh.md)

## Summary

Create independent callback URLs for authorized security tests and read the requests they receive. URLs expire automatically, and one session cannot read or revoke another session’s callbacks. The receiver starts a dedicated loopback HTTP listener and public tunnel on first allocation. Callback traffic never reaches the Harness UI.

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

Mount a [tunnel provider](../security-callbacks-ngrok/README.md) and [callback tools](../security-callbacks-tools/README.md) beside this receiver. The ngrok package includes opt-in profile overlays for ngrok and an operator-managed reverse proxy. No default profile opens a public endpoint.

| Field | Default | Meaning |
|---|---|---|
| `listenHost` | `127.0.0.1` | Loopback address; `::1` is also accepted |
| `listenPort` | `0` | Dedicated listener port; zero requests an unused port |
| `ttlMs` | `600000` | Absolute lifetime per callback URL |
| `maxCallbacks` | `32` | Live URLs across all sessions |
| `maxEvents` | `32` | Retained requests per URL |
| `maxRequestBytes` | `16384` | Body and header byte limits, independently |
| `maxEvidenceBytes` | `131072` | Complete serialized evidence budget per URL |
| `requestTimeoutMs` | `10000` | HTTP request and idle connection deadlines |
| `maxConnections` | `32` | Simultaneous inbound connections |

Call `security_callback_create`, use its URL in an approved test, read with `security_callback_read`, then revoke with `security_callback_close`. Each handle contains `id`, `url`, and `expiresAt`. The collector accepts the exact correlation path and descendants, records method, request path, headers, time, and base64 body, and returns an empty HTTP 204. Unknown, revoked, and expired paths return 404. Oversized bodies return 413; exhausted evidence or event budgets return 429 and increment `dropped`. Read results are detached snapshots and do not consume evidence.

Treat headers, paths, and bodies as untrusted evidence. A hit does not establish a vulnerability, and no hit does not establish safety. Callback creation does not contact a scan target or expand network scope. Headers and bodies may contain sensitive values; tool results persist in the ordinary session transcript. Only active in-memory evidence expires or is discarded on close.

### Custom providers in the plugin DSL

The receiver injects `callbackTunnel`. Implement the exported `CallbackTunnel` service in a local Cordis plugin and select that module in YAML instead of the ngrok module. Its `open(localUrl, signal)` method returns `{ url, close }`: `url` must be an HTTPS origin forwarding to the supplied receiver, and `close()` must await cleanup of resources the provider acquired. Failed publication must clean up or report an unknown remote outcome. The [custom provider](../security-callbacks-ngrok/examples/custom-tunnel.mjs) and [custom overlay](../security-callbacks-ngrok/examples/custom.patch.yml) demonstrate a preconfigured reverse proxy. Keep a fixed `listenPort` when that proxy requires a fixed upstream.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The [receiver](src/index.ts) owns correlation handles, expiration, bounded evidence, and listener teardown. The exported tunnel service keeps ngrok credentials and API details outside capture and tool execution. Initialization is shared across concurrent allocations; a publication failure requires correcting configuration and reloading the receiver. Unload closes local connections even when remote cleanup fails.

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

The `security_callback_create` and `security_callback_read` tools return allocated URLs, retained evidence, and failures through the callback-tools consumer.

#### Token effect

This package adds no prompt tokens directly. Capture budgets bound the evidence returned by the tool consumer.

#### KV Cache effect

No direct prompt or schema contribution. Consumer results append to session history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Protocols** — HTTP(S) callbacks only; no authoritative DNS, SMTP, arbitrary TCP, target scanning, or exploit execution.
- **Retention** — unread evidence is memory-only; expiry, revocation, restart, and unload discard it. The shared listener and tunnel remain until plugin unload, even when all correlation URLs expire.
- **Interpretation** — capture does not verify target identity or distinguish scanner traffic, bots, and genuine target callbacks.

<a id="dev-note"></a>
### Dev Note

None.
