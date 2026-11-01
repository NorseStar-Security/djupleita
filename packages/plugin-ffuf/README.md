# Djupleita · ffuf fuzzing

Included with Djupleita. Find this bundle in **Plugins**, open its card for configuration, or disable it with its switch. Required engagement scope and effect review stay active.

Select **Tool setup → Install ffuf** to download the official, checksum-pinned ffuf 2.3.0 release for Apple silicon or Intel macOS. **Check tools** verifies the executable hash. Terminal alternative, after `pnpm build`: `pnpm setup:tools --only ffuf`, then **Load local setup** in the UI. The executable and license stay under `.pentest/toolchains/ffuf`.

The `pentest_ffuf` tool accepts a fixed HTTP(S) origin with `FUZZ` in the path or query. For example, after authorizing your target:

```json
{
  "url": "https://app.example.test/FUZZ",
  "words": ["api", "docs", "health", "admin"],
  "matchStatus": [200, 204, 301, 302, 401, 403],
  "filterSize": [42],
  "rate": 5,
  "concurrency": 2
}
```

Omit `words` to use the small built-in `common` wordlist. Owners can add named wordlists through plugin configuration:

```json
{
  "ffuf": {
    "wordlists": { "application": "/absolute/path/to/application-paths.txt" },
    "timeoutMs": 300000
  }
}
```

Then pass `"wordlistId": "application"`. The model selects a wordlist ID, not an arbitrary file path. Lists are limited to 10,000 entries and 2 MiB and must fit the engagement's remaining request budget. Inline words override the selected list. `pentest_ffuf_doctor` reports binary readiness and available wordlist IDs.

Supported controls include `method`, fixed `headers` and `body`, `identityId`, `matchStatus` (`"all"` or a list), `filterStatus`, `filterSize`, `filterWords`, `filterLines`, `rate`, `concurrency` and `maxResults`. Supply credentials through an identity reference. Run with different identity IDs to compare observations across accounts.

The confined ffuf process sends generated requests to a private local gateway. The existing HTTP broker checks each actual target URL, pins DNS, supplies host-bound credentials, enforces request/rate/concurrency/byte budgets and reviews effects. A blocked destination or destructive action uses the same **Allow once / Always allow / Keep blocked** controls beside the chat. Responses passed to ffuf are redacted; target cookies and redirect headers are not forwarded to the worker. Redirects are not followed.

Matches create evidence-backed endpoint observations in **Pentest → Graph** and enter the shared scoped crawl frontier. Request evidence and `fuzz/start` / `fuzz/result` events remain in the trajectory. Tool output is capped by `maxResults` (default 100); complete match metadata stays in local evidence. Failed or incomplete runs report `completed: false` and concrete diagnostics. A matching response does not establish a vulnerability.

This adapter supports URL path/query fuzzing on a fixed host. Hostname/vhost fuzzing, header/body placeholders, recursion, external mutator commands and arbitrary CLI flags are not exposed. Matching sizes, words and lines use the redacted response bodies delivered to ffuf.
