---
description: "Run ProjectDiscovery recon tools behind instructor-enforced domain and IP scope."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-recon-projectdiscovery

English | [中文](README.zh.md)

## Summary

Discover subdomains and historical URLs, then explicitly select authorized targets for DNS resolution, HTTP probing, TCP port scanning, or crawling. The plugin uses ProjectDiscovery executables, not a reimplementation of Neo. All discoveries remain observations; a successful process never expands scope.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Use the dedicated [Linux course runtime](../../../course/scope-runtime/README.md). Its image installs checksum-pinned releases from [recon-versions.json](../../../course/scope-runtime/recon-versions.json), and its profile mounts this provider plus the tool consumer. For another explicit composition:

```yaml
- name: '@deepseek-ai/dsh-experimental-recon-projectdiscovery'
  config:
    proxy: http://127.0.0.1:3128
    resolver: 127.0.0.1
- name: '@deepseek-ai/dsh-experimental-recon-tools'
```

Mount `networkScope`, a local `subprocess` provider, `tools`, and `sandboxPolicy` first. Keep all research processes under UID 1000 in the gateway namespace without capabilities. Remote subprocess providers are rejected; this plugin cannot attest correct kernel/UID deployment. File policies narrower than `danger-full-access` require a fully enforcing sandbox provider and are never widened.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-recon-projectdiscovery) owns every field and default. Instructor controls include executable paths, passive sources, proxy/resolver, ports, rate, workers, crawl depth, deadlines, and byte/record limits. Only one operation runs per provider at a time. CLI auto-update checks are disabled.

The default passive sources are Subfinder `crtsh` and URLfinder `waybackarchive`. The shipped course policy and Network Scope reset defaults grant gateway `infrastructure` access for the pinned releases: HTTPS GET `/` on `crt.sh` and HTTP GET `/cdx/search/cdx` on `web.archive.org`. Existing saved policies must include these grants before passive discovery. Subfinder attempts PostgreSQL before its HTTPS fallback; keep direct port 5432 denied. Source APIs are operational exceptions, never research targets. Discovery never adds source API permissions; additional sources require explicit grants.

The default crt.sh and Wayback sources require no API keys. Credential-backed sources have no supported key-entry flow in this adapter yet: each operation uses an isolated HOME and an empty `providers.yaml`, so a normal host Subfinder/URLfinder provider file is not inherited. Selecting another source does not configure its credentials or grant its network access. **Settings → Models** configures model credentials, not reconnaissance source credentials.

Empty output is not proof that no assets exist. The pinned passive tools can return exit zero with empty stdout and stderr after an API error; `diagnosticsPresent: false` does not attest source health. Results carry `coverage: best-effort`. Provider stderr is not forwarded because it can contain credentials or response content.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The [Neo Recon Agent description](https://docs.neo.projectdiscovery.io/platform/agents/discovery/recon-agent) inspires passive-first discovery and structured inventories. [Subfinder](https://github.com/projectdiscovery/subfinder) and [URLfinder](https://github.com/projectdiscovery/urlfinder) provide passive discovery. Explicit active operations use [DNSx](https://github.com/projectdiscovery/dnsx), [HTTPx](https://github.com/projectdiscovery/httpx), [Naabu](https://github.com/projectdiscovery/naabu), and [Katana](https://github.com/projectdiscovery/katana); these active extensions are distinct from Neo's documented passive workflow.

[Adapters](src/components.ts) build fixed argv without a shell. Targets cannot supply flags, filenames, arbitrary queries, or commands. Naabu uses TCP CONNECT and individual IP targets with separate IP/CIDR grants. Katana uses exact-host crawl scope, disables redirects, and does not enable headless mode, automatic form filling, or credential validation. The gateway still controls redirects, embedded traffic, and DNS; tool flags are not a firewall.

[Policy validation](src/scope.ts) accepts domain-only or IP-only policies; an omitted grant category permits nothing. CIDRs require network addresses without host bits. Malformed CIDRs and IPv4-mapped IPv6 grants fail closed, matching the gateway.

Instructor DNS rules must use explicit ASCII/Punycode names in `domains`, `exclude_domains`, `infrastructure`, and `domain_addresses`. Unicode tool inputs remain supported against the corresponding Punycode grant. See the [policy migration guide](../../../docs/upgrade-guide/v0.2.1-alpha.3/scope-policy-ascii-names/guide.md); this avoids ambiguous Unicode mappings between the provider and gateway.

The [executor](src/index.ts) checks target grants and exclusions before executable resolution, verifies gateway health/identity after execution, uses a private temporary HOME/config/cache, and joins managed subprocess ranges on cancellation or disposal. The subprocess provider scrubs credential-shaped ambient variables. No credentials are added by this adapter. Malformed JSONL, failed processes, lost stream bytes, record overflow, or oversized serialized results fail visibly without returning a partial inventory. Normalization retains selected asset/status/title/technology fields rather than raw bodies. Temporary files are removed after termination.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — enforcement and deployment.
- [Tools subsystem](../../../docs/subsystems/tools.md) — execution and events.
- [Testing policy](../../../docs/testing.md) — composition and replay evidence.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the recon-tools consumer that renders provider inventories and failures.

#### KV Cache effect

No direct prompt or schema changes. The consumer appends bounded results; installing binaries or changing provider budgets does not itself replace the model prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Not Neo parity** — proprietary PDCP enrichment and breach-credential lookup are not implemented. Uncover, ASNmap, cloud inventory, TLS enrichment, and Nuclei vulnerability testing require separate reviewed adapters; discovered networks must not become authorization.
- **Best-effort coverage** — upstream APIs may rate-limit, fail silently, or return stale data. The plugin has no completeness attestation or persistent asset graph; diagnostics indicate stderr presence, not a sanitized upstream error report.
- **Deployment evidence** — fixture tests do not establish firewall enforcement or full course-image readiness. The course runtime reference owns those validation limits.

<a id="dev-note"></a>
### Dev Note

From the repository root, standalone CLI checks verify pinned flags and active JSONL, plus passive source routing, JSONL, upstream errors, and cancellation against loopback fixtures in unprivileged containers with external networking disabled. These checks do not contact live passive APIs or attest the gateway. The [runtime reference](../../../course/scope-runtime/README.md#verify-the-boundary) owns full-image and enforcement validation.

```sh
docker build --target recon-tools -t dsh-course-recon-tools -f course/scope-runtime/Dockerfile.research .
node --import tsx/esm course/scope-runtime/tests/recon_cli_cases.mjs | docker run --rm -i --network none --cap-drop ALL --user 1000:1000 -v "$PWD/course/scope-runtime/tests:/checks:ro" --entrypoint python3 dsh-course-recon-tools /checks/recon_cli_smoke.py
node --import tsx/esm course/scope-runtime/tests/passive_cli_smoke.mjs
```
