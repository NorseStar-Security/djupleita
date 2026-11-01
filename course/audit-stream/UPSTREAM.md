# Preserved course feature

Author: Pedram Amini.
Source: https://github.com/NorseStar-Security/djupleita/tree/c38d1112d02d4c695873dd05b32fd9238bdb2a75/course/audit-stream
Original implementation merged in commit 4ec73cd29c2d2b125e2524a101b680e9a9b1d218, with the later feature-branch changes through c38d1112d02d4c695873dd05b32fd9238bdb2a75 retained.

The worker, token tooling, live board, R2 custody ledger, course writer, seat listing, and operator publish route are retained. Djupleita adds an OTLP JSON sender, wrapped-event activity projection, and integration tests. The older whole-harness Docker collector is superseded by the explicit in-process telemetry mode documented in README.md; its isolation guarantees are not claimed for the new sender.
