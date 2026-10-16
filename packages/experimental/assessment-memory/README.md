---
description: "Keep evidence-backed business assets, assessment work, corrections and handoffs across repeated security engagements, with automatic recon intake and attributed RAGE exchange."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-assessment-memory

English | [中文](README.zh.md)

## Summary

Retain discoveries and operational history across assessments of one business. Explain evidence-supported capability paths, inspect planned coverage and create retest work when supporting facts change. Structured recon results update the graph automatically after a session binds to its assessment; browser and terminal discoveries require explicit evidence-backed submissions. Operator configuration selects the business and engagement. Discovered relationships and candidate paths never grant permission to contact a target.

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

Mount this opt-in Host plugin alongside Tools, System Prompt and Storage Domain. Use an existing SQLite-backed domain route, or configure the storage plugins explicitly. Keep the database and composition under operator control. Use a different domain name for each business. Domain names accept lowercase letters, digits and underscores, starting with a letter.

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-sqlite'
  config:
    path: /operator-data/assessment-memory.sqlite
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: sqlite
- id: assessment-memory
  name: '@deepseek-ai/dsh-experimental-assessment-memory'
  config:
    businessId: example
    businessName: Example Business
    assessmentId: example_2026_october
    objectives: ['Assess the approved public services']
    scopePolicyHash: REPLACE_WITH_CURRENT_SCOPE_STATUS_POLICY_HASH
    validFrom: '2026-10-01T00:00:00.000Z'
    validUntil: '2026-11-01T00:00:00.000Z'
    domainName: example_assessment_memory
```

Replace the example business, objectives, dates, database location and policy hash before loading. Do not duplicate storage providers already present in the profile. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-assessment-memory) lists the settings; the [service schema](src/index.ts) owns defaults. The plugin performs no collection, scanning or scheduling itself.

Start a session with `memory_begin`, accurately supplying the environment, principal and network vantage point. This writes an immutable session binding and returns current context. Recon execution requires that binding. Query relevant assets and attempts before acting. Tools and runtime guidance remain available through ordinary Harness model interfaces; no separate agent-loop implementation is required.

Use `memory_schema` for the exact JSON submission schema, then `memory_record` for explicit observations and operational records. Retain each submission's retry key; reusing it with different content fails. Recording references requires existing assets or records. Tasks use expected revisions and expiring exclusive claims; settling requires the current claim owner. New assets create review tasks, and changed observations create follow-up review tasks without running them. Large receipts return bounded identifier lists with an explicit truncation flag; retrieve remaining observations through queries.

Evidence submissions include a source, locator, SHA-256 content hash, summary and observation timestamp. Store original evidence at the locator; this plugin does not copy or authenticate it. Submit vault references instead of credentials. Use `retract` to supersede an unsupported assertion while keeping its history. A failed collector or empty inventory never removes an earlier asset.

Identity, resource and business-service observations can carry an `identity` with provider, realm, nativeType and nativeId. This tuple owns their stable business-local identity even when a display label changes; different account or tenant realms remain distinct. DNS names, addresses and endpoints retain separate identities. Use authoritative native identifiers; this does not perform ownership verification or merge uncertain aliases. Observation queries expose both observedAt and recordedAt.

Record an `objective` linking an existing business-service asset to target assets, an owner, impact and success criteria. A `capability` states a directed action under the bound environment, principal and vantage. It needs current observed support, a validity interval, conditions, an exact validation method and configuration fingerprint. Every `requires` prerequisite is an AND requirement. Imported, inferred, retracted or superseded observations cannot establish capability support. A blocked capability remains blocked even when its evidence also needs revalidation.

`memory_paths` searches bounded simple chains between exact asset ids and explains supporting evidence, conditions and prerequisite branches. A prerequisite's source must be reachable from the assumed entry before it can contribute control. Depth, examined-edge and result bounds are explicit; truncated and empty searches do not establish that no path exists. Entry control remains an assumption requiring assessment evidence. Persist a selected chain with a `path` record and its business objective to pin the capability and objective revisions for later comparison.

A capability becomes validated only through a current completed confirmed attempt in the same assessment, with the same validation method, configuration fingerprint and access context, covering both endpoints and following the capability evidence. Supporting observations must remain unchanged. A path is validated only while every step and prerequisite meets those conditions. Validation is an attributed assessment claim, not independent reviewer approval or authorization. Evidence confidence is separate from execution feasibility and is never a success probability.

Changed facts, retractions and dependency revisions invalidate dependent paths and capabilities. The same durable transaction generates deduplicated `retest:` tasks. Expiry is evaluated on every query; expiration generates durable retest work on the next journal operation. Replace stale evidence, record fresh matching attempts, update affected capabilities and deliberately revise the path before reusing its conclusion. Historical retest tasks require explicit claim and settlement; a new assertion never silently closes prior work.

Use `coverage-plan` records to name asset/test/context/configuration cells for an objective. The `coverage-matrix` view distinguishes untested, failed-to-execute, blocked, inconclusive, confirmed and not-reproduced outcomes, and marks changed or expired attempts for revalidation. Attempts from other access conditions or configuration fingerprints do not fill a cell. A not-reproduced result applies only to its recorded test and conditions; planned coverage is not an inventory completeness claim.

Attempts retain their method, tool version, access context, configuration fingerprint and applicability deadline. Queries flag expired attempts, changed supported observations and mismatched session contexts; an operator must still judge whether the supplied configuration fingerprint applies. Fix verification requires a later completed, not-reproduced attempt covering the same finding assets in the current assessment, with unchanged supported observations, a current applicability deadline and the original finding access context. Cleanup and defender outcomes remain explicitly reported evidence claims.

For a later engagement, preserve the business id and storage domain, configure a new assessment id and current objectives, dates and policy hash, then start a new session. Previous knowledge remains queryable. Reusing an assessment id with changed metadata fails. Historical reads remain available after engagement expiry; new recorded work requires a current engagement.

`memory_status` reports pending capture, failures, adapter coverage and dispatches with unknown outcomes. Automatic intake failures latch a degraded state and block subsequent recorded execution. Correct storage or configuration, reload, and reconcile incomplete operations against Session evidence before repeating potentially stateful work. A journal cap never silently drops old records. Back up the database before operator-managed archival or configuration changes.

`memory_rage_export` returns a complete RAGE v0.1 NDJSON graph with attribution, evidence links and explicit assessment extensions. `memory_rage_import` accepts a bounded supported bundle, preserves native node identifiers and type metadata, and records imported relationships as unvalidated hypotheses. Import does not authenticate upstream evidence. Operational records and capability analysis remain in `memory_query` and the journal; graph exchange excludes them. Native identity tuples are retained in exported node identifiers. Unknown RAGE kinds are ignored; ZIP packaging is unsupported.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The [service](src/index.ts) serializes immutable, schema-validated journal transactions through Storage Domain. It validates a candidate projection before writing and publishes the new projection only after storage acknowledges durability. Replay checks sequence, event identity and payload hashes before reconstructing state. These hashes detect accidental inconsistencies; they do not authenticate a database against an attacker who can rewrite it. The domain backend owns physical storage and file permissions.

A Tools execution wrapper records dispatch intent before a bound call enters its executor. The immutable final outcome observer records results and invokes the [recon adapter](src/recon.ts). A crash between execution and outcome capture leaves an incomplete dispatch, whose external effects remain unknown. Capture receipts enter the initiating Session as ignorable plugin records. Registry contributions and queued writes belong to the plugin lifecycle and drain on unload.

The [projection](src/state.ts) retains assertions separately from current assets. Stable identities normalize DNS names, IP addresses and HTTP endpoint identities; endpoint query strings and fragments are excluded. DNS owner names retained by the recon provider support precise address and alias relationships. Conflicting observations stay available with their sources and timestamps. The [RAGE adapter](src/rage.ts) emits structural custom relationships without assigning attacker traversal semantics. It does not execute RAGE's rule corpus or establish exploitability.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [NOTICE](NOTICE) — attribution to TrustedSec RAGE, DeepSeek Harness, ProjectDiscovery and the design references.
- [RAGE format](https://rage.fail/format) and [upstream repository](https://github.com/trustedsec/RAGE) — exchange specification and original project.
- [Recon provider](../recon-projectdiscovery/README.md) — supported collection and completeness limits.
- [Storage Domain](../../storage/storage-domain/README.md) — durability and backend routing.
- [Tools subsystem](../../../docs/subsystems/tools.md) — dispatch, accepted outcomes and Session logging.

<a id="model-experience"></a>
## Model Experience

### Assessment context, tools and results

#### What the model sees

The plugin registers `memory_begin`, `memory_query` and the other memory tools with required dynamic runtime guidance. Before binding, that guidance directs the model to begin an assessment. After binding, it supplies the configured business, assessment, access context, journal revision, open-task count, unknown-outcome count, capability/path/coverage-plan counts and capture health. Guidance directs the model to inspect path explanations and retest work before reusing conclusions. Detailed retrieval is explicit through bounded queries. Tool schemas and generic cards expose the same operations in native and nested execution.

#### Token effect

Fixed tool schemas accompany requests while mounted. Dynamic context contains bounded identifiers and counts rather than the full graph. Record-schema retrieval, query pages and exports append result text on demand and are bounded where configured. Loading the complete record schema has a larger token cost than ordinary queries.

#### KV Cache effect

Tool results append to history. Runtime context changes with journal state and is materialized through the existing durable prompt mechanism. Mounting, unloading or changing tool definitions changes the schema prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One configured business and engagement per service instance; database permissions and operator-controlled configuration provide isolation. Session bindings are attribution, not authentication. Shared multi-tenant hosting requires a separate authorization layer.
- Graphs and journal projections reside in process memory. Storage Domain supplies single-process writes; distributed workers and multiple processes sharing one domain are unsupported. No automatic journal compaction, migration or encrypted evidence vault is provided.
- Automatic asset extraction supports accepted `recon_run` results only. Other bound tool outcomes are journaled with hashes and Session references; their coverage remains unparsed until explicitly recorded. No background replay of missed Session results is performed after a crash.
- Suggested tasks do not execute automatically. No recurring schedules, cloud collector, RAGE derivation engine or graph visualization is installed. Custom graph relationships remain structural; validated hypotheses are recorded evidence claims rather than independent verification.
- Ownership verification, reversible entity merges, independent reviewer authentication, historical as-of queries and automatic revalidation of legacy relationship hypotheses are not provided. Capability paths use explicitly submitted assertions rather than an imported rule corpus.
- Import validates the supported record fields and local node/edge references, not the entire upstream taxonomy, rule corpus or original evidence chain. It normalizes imported relationships to hypotheses and is not a lossless RAGE round trip. Evidence locations must remain accessible through their owning systems.
- Complete-byte limits can reject a query or export; narrow queries or increase the operator-configured bound. Offset pages can shift under concurrent writes. The schema tool returns a fixed schema rather than an arbitrarily sized graph.

<a id="dev-note"></a>
### Dev Note

None.
