---
description: "Run course browsers, terminals, scripts, and TCP-connect scanners behind a Linux domain/IP scope boundary. Configure destinations, inspect denials, and verify the isolated runtime."
---

# Scope-enforced Linux course runtime

English | [中文](README.zh.md)

## Summary

Keep browser, terminal, code, and MCP capabilities available behind destination enforcement and mandatory action review. The course UI defaults to isolated Linux research, not host tool execution. Run it in a dedicated Linux VM with Docker Compose v2. The unprivileged research container cannot edit the gateway policy, review credentials, or authoritative review ledger. No host firewall or certificate store is changed. This is a course prototype, not a production security certification.

Local trajectory collection is mandatory for course research. Remote copying remains an optional instructor-side [collector deployment](../trajectory-collector/README.md); student-image enrollment and authenticated ingestion remain release prerequisites, not completed identity infrastructure.

## Table of Contents

- [Run an exercise](#run-an-exercise)
- [Policy reference](#policy-reference)
- [Action review](#action-review)
- [Enforcement and trust](#enforcement-and-trust)
- [Verify the boundary](#verify-the-boundary)
- [Limitations](#limitations)
- [Dev Note](#dev-note)

<a id="run-an-exercise"></a>
## Run an exercise

From the repository root, edit [scope.json](scope.json) as the instructor. Replace reserved example names with destinations for which you have authorization; include each required dependency deliberately. Keep this checkout, Docker access, gateway, and policy outside the agent's writable workspace.

The immutable active policy is readable inside the research container at `/run/course-public/policy.json` and through the model's `scope_status` tool. Include policy inspection in the exercise instructions so the agent checks its authorized destinations before acting.

On an Apple Silicon Mac, create a dedicated native profile without selecting its Docker context:

```sh
mkdir -p /private/tmp/dsh-course-empty-mount
colima start --profile dsh-course --arch aarch64 --vm-type vz --cpus 4 --memory 8 --disk 60 --runtime docker --activate=false --mount /private/tmp/dsh-course-empty-mount:ro
```

Enable **Network Scope** and **Reconnaissance** in Plugins. Their Configure pages stage edits; Save creates a pending revision and Apply starts it. A running environment requires **Stop and apply**. With the course bundle's default configuration, the native controller stores drafts, immutable snapshots and operation logs in `$DSH_HOME/course-runtime`. It targets `colima-dsh-course` explicitly and uses named home/workspace volumes, with no Mac workspace or Docker socket inside research. Policy validation uses the gateway’s Python implementation. A failed apply leaves research stopped and preserves drafts and data.

The **Research runtime** selector distinguishes **Host management** from **Isolated Linux**. Host tools are denied by default; the trusted deployment option `allowHostResearch: true` is an explicit instructor escape, not a browser preference. The root page selects isolated research only after the saved and applied revisions match and gateway, reviewer, and collection readiness have been observed. Otherwise it opens setup, never a host-research fallback. Session selections are separate and switching never migrates sessions. Apply inherits enabled bundles and referenced saved model credentials while preserving isolated model overrides. The local collector and projection must be loaded; the isolated viewer uses their existing UI. Native archive write credentials and reviewer keys never enter research. The Advanced option forwards only `OPENAI_API_KEY` for the research model when explicitly selected; telemetry remains disabled.

The native controller requires this source checkout, Python 3.11+, Docker, and the dedicated Colima context. Research uses the gateway resolver at `127.0.0.1`; if no external resolver is available in the gateway configuration, its upstream defaults to `1.1.1.1`. Native-library caching uses the named home volume, preserving the read-only system and restricted temporary mount.

Use Network Scope to configure [review.json](review.json), an explicit reviewer model and credential reference, operation rules, and the local collector before Apply. Empty reviewer models are deliberately not runnable defaults. Save stages settings; it does not reconfigure active research. Existing installations need the [review migration](../../docs/upgrade-guide/v0.2.1-alpha.3/course-action-review/guide.md).

The static Compose file is a network-diagnostic fixture, not a substitute for the native collection owner. It can build images and dump the composed headless configuration:

```sh
DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) docker compose -f course/scope-runtime/compose.yml build
docker compose -f course/scope-runtime/compose.yml up -d --wait gateway
docker compose -f course/scope-runtime/compose.yml run --rm research node /opt/dsh/apps/cli/lib/bin.js --profile headless --patch /opt/course/profile.patch.yml --dump-config
```

The [profile patch](profile.patch.yml) mounts the [scope provider](../../packages/experimental/network-scope-linux/README.md), [scope guard](../../packages/experimental/network-scope-guard/README.md), [action-review provider](../../packages/experimental/action-review-linux/README.md), [mandatory review guard](../../packages/experimental/action-review-guard/README.md), and local Playwright MCP browser tools. Missing review services deny tool dispatch, including in this headless profile. The filesystem policy uses `danger-full-access` inside the container; container permissions and the network boundary still apply. General upstream headless profiles are not rewritten into course deployments.

Run model-backed course exercises through the configured isolated runtime. A research model endpoint requires its own explicit infrastructure permission; reviewer traffic originates in the trusted gateway and uses its separately configured endpoint. Do not use production credentials or browser sessions.

The image also installs checksum-pinned ProjectDiscovery tools and mounts the [recon plugins](../../packages/experimental/recon-projectdiscovery/README.md). Their catalog is passive-first, and active runs require explicit consent plus instructor target grants. The shipped policy and Network Scope reset defaults include the limited passive-source API permissions documented in the recon reference. Existing saved policies keep their explicit grants; recon never expands a policy during discovery. Ordinary tool events retain the inventories and denials for the trajectory collector. The recon reference owns supported components, source setup, and limitations.

Stop the environment before changing scope or restarting the gateway:

```sh
docker compose -f course/scope-runtime/compose.yml down
```

The next start reads a new immutable policy snapshot and generates a new course CA. Named workspace/home volumes retain course work and Session data; `down` does not delete them. The public CA is imported only into the research container. The CA private key stays in gateway-only temporary storage. View gateway decisions with `docker compose -f course/scope-runtime/compose.yml logs gateway`.

<a id="policy-reference"></a>
## Policy reference

The policy accepts only the fields below. Invalid policy prevents startup. Exclusions override grants; exact domains do not include subdomains. The network-only diagnostic policy can grant raw IP/CIDR traffic, but course Apply requires `operations.requireMediatedHttp: true` and rejects raw IP grants: otherwise direct TLS could bypass operation inspection. Domain address pins remain usable without raw IP grants.

Use explicit ASCII/Punycode DNS names in `domains`, `exclude_domains`, `infrastructure`, and `domain_addresses`, including wildcard suffixes. Unicode policy names are rejected rather than ambiguously mapped; Unicode recon tool inputs remain supported against explicit Punycode grants. Existing policies with Unicode names need the [policy migration](../../docs/upgrade-guide/v0.2.1-alpha.3/scope-policy-ascii-names/guide.md).

| Field | Meaning |
|---|---|
| `domains` | Exact DNS names and explicit descendant-only `*.lab.test` rules; list the apex separately. |
| `ips` | Explicit IPv4/IPv6 addresses or canonical CIDRs for direct connections and scanning. |
| `exclude_domains` | Exact or wildcard hostname exclusions. |
| `exclude_ips` | Address/CIDR exclusions, including addresses resolved for allowed domains. |
| `domain_addresses` | Optional exact-host IP arrays for private lab fixtures; pins authorize proxied domain requests, not raw IP access. |
| `infrastructure` | Exact host → `methods` and exact `paths` arrays for operational services, not target authorization. |
| `ports` | Optional `http` and `https` port arrays for the gateway; defaults are `[80]` and `[443]`. |
| `operations` | Required for course Apply: `requireMediatedHttp`, `deny` rules, and a shared `budget` with `maxRequests`, `windowSeconds`, and `maxConcurrent`. |

Target domains and raw IP scope are separate grants. Authorizing `acme.test` does not authorize `widgets.test`, `sub.acme.test`, or scanning every IP returned by Acme DNS. Shared CDN addresses never become kernel allow rules automatically. Raw IP/CIDR grants are available only in network-diagnostic policies, not secure course Apply; other protocols need a separately reviewed mediated boundary. An excluded hostname cannot revoke a separately authorized raw IP: raw traffic has no reliable company identity.

The example permits limited model and passive-source API operations through `infrastructure`. This allows requests to those paths, not arbitrary browsing of that host. It does not validate request bodies or prevent misuse of an allowed API. Add registries, search providers, authentication hosts, or remote MCP services only after reviewing their destination and operation permissions; they are not automatically exempt. Image builds download dependencies outside the research boundary and must use trusted sources without exercise secrets.

Operation deny rules contain a unique `id`, `methods` (`["*"]` for all methods), exact `paths`, and path-tree `prefixes`. Denies always win, including on infrastructure hosts; infrastructure permissions remain exact even when the same host is also a target. Paths are decoded once and checked for ambiguous encodings, separators and dot segments before matching. The default blocks `/quitquitquit` and descendants for every method. It is an example deny rule, not a universal inventory of administrative endpoints. The shared budget applies across target hosts and HTTP/TLS connections; a rate denial never queues a retry. WebSocket upgrades consume admission, but frames are not individually inspected or rate-counted.

<a id="action-review"></a>
## Action review

Every ToolRuntime dispatch, including PTC outer and nested calls, native tools, browser/MCP tools and subagent calls, passes the separate [action-review service](../../packages/experimental/action-review/README.md). Each request binds exact serialized input, Session/call identities, tool schema, network policy and reviewer configuration hashes. Agentless or unknown-schema calls, changed deployments, unavailable services, cancelled reviews, malformed results and storage failures cannot admit a tool. General permission presets cannot override this guard, and model approval cannot override deterministic scope or operation denials. Unloading a mandatory review guard/provider closes admission until the process restarts.

The instructor configures `rulesOfEngagement`, risk `rubrics` and one or more mandatory `evaluators` in [review.json](review.json). `destructive` and `insufficient_context` are required rubrics; add `reckless`, privacy or other dimensions without editing the agent loop. A risk at or above its `maxProbability` denies. The `llm` provider uses an OpenAI-compatible HTTPS chat endpoint with strict JSON risk scores. The `jev` provider uses TypeSafe's [System One API](https://docs.typesafe.ai/introduction/quickstart), typed `noul` questions, and an explicit instructor-selected model. Providers never supply final authority. All configured evaluators must complete successfully; there is no permissive fallback or one-click approval bypass.

Trusted gateway modules can extend the registry with `register(registry)` and `registry.add(kind, evaluator)`; `plugins` names modules installed in the instructor-owned image. Evaluators receive the immutable policy, redacted call and rubrics and return `(actualModel, risks)`. Optional evaluator `options` holds plugin-owned JSON settings. Credentials resolve only explicit `credentialRef` values on the native host and are seeded into a gateway-only volume. Redaction of configured keys or credential fields causes a context denial, not a truncated approval. Other secrets cannot be detected reliably: tool arguments sent to a remote evaluator require an appropriate course data policy.

The gateway commits a deny/pending receipt before invoking evaluators, then a final decision before acknowledging admission in `review-audit:/var/lib/course-review/decisions.sqlite3`. Crashed pending reviews never grant permission. The bounded ledger retains input hashes, redacted action, policy/model versions, scores and outcomes, not hidden model reasoning. SQLite commit failure or capacity exhaustion closes review; instructors must archive/rotate the gateway-owned volume deliberately, not delete it during research. The native collector receives Session decision/result records for the trajectory viewer and optional remote export; an allow receipt means admission, not proof of execution or successful target effects.

The native collector renews a gateway-private lease only after durable intake. No admission is granted before the first renewal. `archiveLeaseSeconds` bounds how long new admission survives native disappearance; `startupGraceSeconds` permits worker startup health checks but never grants tools. Intake failure stops research, and lease expiry during evaluation denies. Full trajectory records originate in the worker and are not tamper-proof attestation; authoritative admission receipts stay outside it. HTTPS provider replies and inputs have configured byte/deadline bounds and no redirects or automatic retries. Human exception approval and identity enrollment are not implemented by this baseline.

<a id="enforcement-and-trust"></a>
## Enforcement and trust

The gateway owns a private network namespace shared with the research container. Its nftables OUTPUT rules filter sockets owned by research UID 1000, regardless of tool name, program language, proxy environment, or subprocess depth. The research container drops every Linux capability, including the bounding set, and sets `no-new-privileges`. It has no Docker socket, host networking, published ports, or host workspace mount. Private namespace loopback remains open for local browser control and gateway services; it is not the host's loopback.

HTTP(S) traffic uses the scope gateway. HTTPS CONNECT terminates at the ephemeral course CA rather than opening an opaque tunnel. The gateway compares the request URL, Host header, and CONNECT authority, validates all DNS answers, and connects to a pinned address with upstream TLS hostname verification. Redirects, frames, scripts, service workers, popups, and WebSockets use the same network boundary; browser routing hooks are not the enforcement mechanism. Programs that ignore the proxy still encounter the kernel IP rules. IPv4 and IPv6 are both covered. DNS requests use a scoped resolver; Docker's embedded DNS shortcut is blocked for research processes.

Gateway network logs contain decision time, policy hash, transport, hostname/IP, and applicable port/method/reason, not paths, queries, credentials or payloads. The separate review ledger contains redacted actions and needs stricter retention. NFLOG monitors kernel denials. Monitor failure terminates the gateway; installed kernel rules persist while research retains the namespace. HTTP denials normally return `403`; oversized already-uploaded TLS bodies may cause an incomplete or absent denial response. Direct denials appear as socket errors/timeouts. Environment decisions remain `plugin:network-scope-guard/network` Session records, distinct from pre-dispatch action receipts.

The [service definition](../../packages/experimental/network-scope/README.md), Linux provider, and judge/audit consumer are Cordis plugins; no agent-loop changes are required. The provider reads the root-owned `/run/course-public/control.sock` through a read-only volume. This interface exposes immutable policy, live health, structured target decisions, and a 1024-event sequenced audit ring, with no policy mutation or firewall controls. The judge checks each dispatch and rejects mapped out-of-scope HTTP targets before execution. Unmapped capabilities stay open behind network enforcement. A lost audit cursor or changed identity stops dispatch until instructor investigation and reload; a temporary transport outage can recover after a successful check.

The trusted computing base includes the Linux kernel, Docker daemon, gateway process and dependencies, instructor policy, resolver, and CA. Use a VM dedicated to the course. Do not grant researchers root, Docker access, extra capabilities, host sockets, another network interface, or external executors: those alter the boundary. [Design rationale](../../.agents/notes/implemented/architecture/2026-10-14-course-network-scope.md) records the trade-offs.

<a id="verify-the-boundary"></a>
## Verify the boundary

Run stdlib unit tests with Python 3.11+ and OpenSSL, then run the Linux integration suite with a running Docker engine:

```sh
cd course/scope-runtime
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'test_*.py' -v
cd ../..
python3 course/scope-runtime/verify.py
```

The suite creates a unique disposable Compose project. Controlled `acme.test` and `widgets.test` endpoints stand in for different companies; no real Acme or Widgets endpoint is contacted. Allowed controls must succeed, while outside-domain, excluded IPv4/IPv6, and proxy-bypass attempts must leave forbidden HTTP-request, accepted-TCP-connection, and received-UDP-datagram counts at zero. Chromium runs with service workers enabled and without request interception. The suite also checks read-only policy decisions and audit sequence continuity, kernel/proxy records, a deliberate test-only firewall regression, and retained kernel filtering after supervisor loss. Cleanup removes only that test project's containers, network, and disposable volumes; build images remain cached.

The [Loader integration tests](../../packages/experimental/network-scope-guard/tests/loader.spec.ts) verify the real provider/consumer composition and its unload behavior. The [keyless CLI Session](../../snapshots/session/network-scope/session.v4.jsonl) records `scope_status`, an allowed terminal control, and a pre-dispatch `widgets.test` fetch denial against a deterministic policy provider. Build verification and live-model exercises remain separate from fixture replay.

Native ARM installations can run `python3 course/scope-runtime/verify.py --context colima-dsh-course --prebuilt` and `python3 course/scope-runtime/tests/image_smoke.py --context colima-dsh-course --image dsh-course-research:local --gateway-image dsh-course-gateway:local`. These use disposable named configuration volumes, without Mac directory bind mounts.

For a separate built-image check, run [image_smoke.py](tests/image_smoke.py) with `--image` and `--gateway-image` naming your built harness and gateway images. It creates a disposable offline namespace, uses the real course plugins with a deterministic model replay, and checks the composed profile plus a durable `widgets.test` recon denial and completed turn. It requires no model credentials and removes only its own project and volumes. This replay is not a live-model or live-source check.

Run real browser operation checks with `python3 course/scope-runtime/tests/browser_operations.py --context colima-dsh-course --image dsh-course-research:local`. The disposable, read-only, offline container uses the image's Chromium and gateway with a trusted fixture CA, not a TLS-validation bypass. Ordinary GET/POST requests must succeed; 52 HTTP/HTTPS requests across 13 shutdown-path variants must leave upstream TCP and HTTP counts unchanged. Removing only the fixture's shutdown rule must make the control requests reach upstream. Only automatic favicon requests are intercepted; the operations under test are not rewritten. Cleanup removes only that invocation's container.

<a id="limitations"></a>
## Limitations

- Raw/SYN scanning and packet capture require privileges that this topology intentionally withholds. Use TCP-connect scanning (`nmap -sT`); do not add `NET_RAW` to bypass this restriction. Privileged scanners need a separately reviewed routed VM boundary.
- Domain-only scope supports mediated HTTP(S)/WebSockets, not every opaque protocol. Certificate-pinned clients, HTTP/3/QUIC, CONNECT tunnels for arbitrary protocols, and unsupported HTTP framing may fail closed. Raw IP grants are incompatible with secure course Apply; other protocols need a separately reviewed mediated boundary. Gateway requests have a 30-second I/O timeout, an 8 MiB body limit, and 32 concurrent connections; long idle WebSockets and large uploads can fail.
- LLM/JEV risk scoring is fallible, not a proof of safety or company ownership. Method/path rules do not understand application-specific body/query/header overrides, WebSocket frame commands, every router's normalization, server-side SSRF or downstream pivots. Rate limits constrain gateway admissions, not all target-side effects. Remote executors require equivalent enforcement of their own.
- This runtime does not provide a hostile-container escape guarantee, inbound network isolation policy, or per-Session attribution. All course processes share one policy and workspace. TLS inspection exposes plaintext to the trusted gateway; retain logs appropriately and use lab-only credentials.

<a id="dev-note"></a>
## Dev Note

None.
