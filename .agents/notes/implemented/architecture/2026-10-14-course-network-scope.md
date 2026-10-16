# Agent Note: Course destination scope below tool dispatch

Status: implemented

English | [中文](2026-10-14-course-network-scope.zh.md)

## Problem

Argument adapters cannot constrain destinations chosen by arbitrary programs, browser scripts, redirects, service workers, or subprocesses. Denying every unrecognized tool prevents the course from using those research capabilities. Allowing them without an execution boundary does not enforce scope.

## Decision

The opt-in [course runtime](../../../../course/scope-runtime/README.md) runs tools unprivileged in a dedicated Linux namespace. A separately owned gateway installs UID-based nftables output rules and mediates domain HTTP(S), WebSockets, and DNS. Explicit IP/CIDR grants authorize direct sockets. Domain DNS answers never become raw-IP grants because shared hosting does not establish company ownership.

HTTPS CONNECT terminates at a temporary course CA so the gateway can compare the inner Host with the authorized destination. The research container cannot access the CA key, mutate policy, acquire capabilities, or control Docker. Private loopback permits local browser control. Kernel filtering persists if the supervisor exits; loss of packet monitoring stops the supervisor rather than silently continuing without that monitor.

The argument-only judge remains available for restricted structured-tool deployments. The course patch instead mounts a Cordis scope service provider and judge/audit consumer. The abstract service defines read-only inspection, the Linux provider reads the instructor-owned Unix socket, and the consumer checks mapped destinations before dispatch while retaining environment network records. Destination enforcement remains outside plugin authority because every tool and child process must encounter it even after a plugin is unloaded.

The gateway offers no policy mutation API. Its bounded sequenced journal makes audit loss explicit; the consumer serializes polling and preflight through one cursor and stops dispatch on overwritten cursors or identity changes until instructor investigation and reload. Network records are ignorable experimental Session data, not model instructions or per-tool causal claims. A deterministic keyless CLI snapshot owns model-visible status, terminal allowance, and pre-dispatch denial; the Linux suite owns actual network-counter evidence.

## Alternatives considered

**Enumerating and blocking capabilities.** This rejects browser/code/terminal research rather than authorizing destinations, and every new adapter repeats the same incomplete mediation problem.

**Browser routing hooks or origin lists alone.** These do not cover nonbrowser tools, and hook coverage varies for redirects, service workers, and WebSockets. The course allows service workers and tests the underlying boundary.

**Opening domain-resolved IPs or opaque CONNECT tunnels.** Shared IPs permit other hostnames, and a tunnel cannot validate the inner HTTP authority. Explicit raw-IP scope remains a separate instructor decision.

**Privileged researchers sharing the gateway namespace.** NET_ADMIN can alter the firewall and NET_RAW can create packet paths outside ordinary socket filtering. This topology drops all capabilities; privileged scanners require a routed external enforcement boundary.

## Consequences

Browser, code, terminal, and TCP-connect tools remain usable for authorized destinations without command parsing. TLS inspection requires lab trust configuration and exposes plaintext to the trusted gateway. Certificate-pinned clients and unsupported protocols can fail closed. Explicit IP scope cannot distinguish virtual hosts or company ownership. External executors and server-side pivots require independent controls.

The [verification driver](../../../../course/scope-runtime/verify.py) observes allowed/forbidden server counters, validates a deliberate firewall regression, and tests supervisor loss. It owns a unique Compose project and deletes its disposable resources. Live-model use, raw scanning, escape resistance, inbound policy, and per-Session audit attribution are not established by these tests.

The network suite passes under Docker, including concurrent instances and injected monitor failure. Full DSH image validation remains pending: the local emulated-Linux build completed TypeScript but the upstream bundler exited 132 with a V8 fatal check. This is a runtime prototype, not a verified ready-to-run DSH deployment; validate the built profile on the dedicated Linux course host.
