# Renderer memory investigation — 2026-10-31

Three crash reports on October 30 recorded `Desktop renderer exited: crashed`, at 19:56:36, 20:17:07 and 20:38:31 UTC. The first is corroborated by `.pentest/desktop-rea.log`, which reports:

```text
V8 javascript OOM (MarkCompactCollector: young object promotion failed).
```

This confirms an out-of-memory renderer failure. The trajectory UI was an identified source of avoidable memory pressure: every 1.5 seconds, each visited chat's source requested and retained the complete trajectory, complete graph and crawl frontier. Polling continued after leaving a chat. The affected archive contained 1,751 events and approximately 70 MB of JSON, including individual REA catalog results of about 9 MB. Repeated serialization, parsing, redaction and rendering amplified its size in memory. The available reports do not establish that every reported crash had the same cause.

## Changes

- Desktop trajectory reads stream and verify the complete hash chain, returning at most 100 events with 4 KiB data previews. Unchanged pages share a bounded cache.
- Older pages and full event data are available through authenticated owner routes. Large event data is redacted before being split into 16,384-character display pages.
- Desktop graph reads are limited to 150 nodes and 500 relationships within that page; totals are counted separately. Complete graph exports remain available.
- Polling starts with the first subscriber, stops and releases its snapshot after the last subscriber leaves, and schedules the next request only after the previous one finishes. Leaving a view cancels its pending snapshot request and ignores late responses.
- Status inspection uses the same bounded trajectory path. Initial trajectory append verification also streams the archive.

No recorded events, graph facts, evidence, credentials or scope settings were deleted or changed by this fix. Heap limits were not raised.

## Verification

The full check run passed TypeScript and 78 tests, with six optional tests skipped. Regression tests cover multi-megabyte results, complete-chain tampering outside the displayed page, cache invalidation, large event paging, graph bounds, subscriber cleanup, cancellation and slow/failing polling requests. Owner-route tests cover authorization and pagination input validation.

A read-only measurement against the existing archive produced:

| Measurement | Result |
| --- | ---: |
| Saved archive | 69,726,901 bytes |
| Events | 1,751 |
| Latest 100 event previews | 116,136 bytes |
| Older page containing the large REA result | 96,058 bytes |
| Initial full-chain verification | 699 ms |
| Unchanged cached page | 0.14 ms |
| Large event's original data | 9,163,904 bytes |
| One detail page | 16,384 characters |

The trajectory payload in this sample is 99.8% smaller than the archive. These are local measurements, not a latency guarantee or a long-duration stability test. The private measurement output is `.pentest/crash-benchmark.json`; it contains counts and timings only.

## Desktop restart verification

With the owner's approval, Djupleita and its host were restarted using **Djupleita → Restart App and Host** on October 31 at approximately 11:58 UTC. The new app loaded the paging controls and retained the original chat, 1,751 trajectory events, 480 nodes and 450 relationships.

The native UI successfully loaded an older trajectory page, displayed complete redacted event data through the detail reader, paged the graph from nodes 1–150 to 151–300, and switched to another chat and back. The original chat was left open on live latest events. No model requests or target scans were started for these checks.

No new crash reports appeared during the three-minute verification. Renderer resident memory samples after the restart, page navigation and chat switching were approximately 258–280 MiB. Restarting also resets existing allocations, so these samples do not establish a long-term memory ceiling. The local verification record is `.pentest/crash-restart-verification.json`.

![Restarted desktop with trajectory paging](images/trajectory-paging.jpg)
