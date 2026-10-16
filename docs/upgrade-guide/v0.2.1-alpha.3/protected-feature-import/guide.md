---
kind: upgrade-guide
description: "Applying Protected now imports selected native features and saved model API keys instead of launching a minimal independent profile."
---

# Protected inherits configured native features

English | [中文](guide.zh.md)

## Change

Course Runtime applies now import enabled native bundles, model routes and their referenced product-stored API keys into the private Protected home. Previously Protected launched a minimal profile and needed independent key entry. Later imports refresh inherited values while preserving Protected overrides. Account grants and unrelated host credentials are excluded; account sign-ins require separate Protected authentication. Explicit host `OPENAI_API_KEY` forwarding remains optional.

With native trajectory collection configured, Protected loads the existing viewer and the native controller copies its persisted session records into the native archive under a separate installation identity. Attachment binaries and remote export remain separate opt-ins. Native authentication and archive write credentials stay outside research.

## Migration

1. Rebuild the ARM research image and current native artifacts using the [runtime guide](../../../../course/scope-runtime/README.md).
2. Review active research, then choose **Stop and apply** in Network Scope. This reuses the saved network policy; imported models do not authorize new endpoints.
3. Select Protected and verify **Settings → Models**, enabled Plugins and Trajectories. Protected sessions and files remain separate from Local. Edit Protected model overrides there; subsequent applies preserve them.
