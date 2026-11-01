# Djupleita · Trajectories

Read verified, redacted chat and tool trajectories beside the conversation.

Model inspection returns paginated event metadata through `pentest_trajectory` (20 events by default, at most 50). Use `before` with the returned `nextBefore` to read older metadata, or `eventSeq` for a payload preview capped at 4,096 bytes. The UI and local log retain full payloads, including originals shortened in the model's context by automatic compaction.

Included with Djupleita. Enable or disable this bundle in **Plugins**. Open its card for configuration and engagement controls. Network scope and effect review remain enforced by the required Djupleita engagement services.
