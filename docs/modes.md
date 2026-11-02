# Modes with Pentest tools

Djupleita extends the pinned Harness's Standard, Creator (`cordis`), PTC and Minimal presets. Each retains its original tools, commands, skills and execution setup, with the Pentest persona, goals, delegation and compaction defaults added. The legacy **Pentest** selection remains available as an alias of extended Standard, so existing conversations keep their preset identity.

PTC still exposes `run_code` as its model-facing execution entry. Its generated SDK contains both normal and Pentest tools. Running arbitrary code requires an execution/effect decision; nested tool calls still cross the engagement policy. An execution approval does not grant target scope, filesystem access or approval for nested destructive operations.

Bounded trusted local reads, including file search/read, current-directory inspection, engagement status and permitted trajectory inspection, use deterministic descriptor decisions and do not invoke a model judge. Explicit owner policy rules retain precedence. Changing directory, editing files, launching commands, creating agents and other state changes have separate descriptors. Missing adapters remain visible and require an owner decision. Existing Harness filesystem/access permissions continue to apply.

Subagents inherit the parent's retained preset composition and engagement policy. Scope, destination allowances, budgets, findings and assessment membership are shared according to the engagement/run rules; choosing another mode does not remove the Pentest guard.

Profile upgrades add introduced capabilities while retaining saved provider configuration, default mode selection, custom persona text, plugin settings and disabled choices. Sessions and credentials are not rewritten. Profile patch backups are retained locally before changes. macOS desktop and Linux web use the same preset generator and policy services.

`tests/additive-modes.test.ts` boots the production profile, compares catalogs and commands against the actual pinned base modes, verifies child catalog inheritance, invokes native file and inspection tools, and runs ordinary and Pentest tools through the PTC SDK. The replay and orchestration fixtures check run membership, policy enforcement and goal continuation with local model fixtures. No paid model calls or target scans are needed.
