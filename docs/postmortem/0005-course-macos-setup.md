# Post-mortem 0005: ordinary chat passed while the course setup was incomplete

English | [中文](0005-course-macos-setup.zh.md)

Status: historical record of the initial 2026-10-15 deployment. [PR #10](https://github.com/5stars217/deepseek-harness/pull/10) subsequently added protected feature import and trajectory collection; the linked setup guide describes that current behavior. The Python 3.14 test-CA issue was unresolved at initial verification.

## Executive summary

The 2026-10-15 Apple Silicon installation initially built this fork and passed a live OpenRouter request, but launched the ordinary Web profile. Trajectories, the custom Scope/Recon configuration, and a provisioned Protected workspace were missing. Completing the course deployment also exposed missing Docker CLI plugins and a launch overlay that replaced the protected profile's model providers with OpenAI. The overlay was corrected and a composition regression added. Setup acceptance now includes the requested GUI features and a live protected request, not just a successful chat.

## Summary

This report records the installation changes and their evidence for a setup pull request. The [portable setup guide](../user/guide/course-macos.md) is the current user path; the [runtime](../../course/scope-runtime/README.md) and [collector](../../course/trajectory-collector/README.md) references own their detailed behavior. No API keys, browser login tokens, private certificates, raw session records, or collector databases belong in the proposed PR.

## Environment observed

| Component | Observed value or action |
|---|---|
| Host | Apple Silicon, macOS 15.7.3. |
| Source | Private course fork, version `0.2.1-alpha.3`; source checkout, not an npm-only installation. |
| Git / GitHub CLI | Git 2.52.0 and gh 2.86.0 already available; the existing gh identity could read the private repository. |
| Node / compiler | Node.js 25.4.0 and Xcode Command Line Tools already available; Apple clang 17.0.0. |
| pnpm | Existing pnpm 11.25.0 completed the frozen native install; subsequent native build commands used the workspace's pnpm 11.28.5. The Linux image used 11.28.5. |
| Python | System Python 3.14.6; existing uv-managed Python 3.11.15 selected for the native course controller and passing gateway tests. |
| Docker / Colima | Docker 29.6.1 and Colima 0.10.3 already available. Existing unrelated VM profiles were retained. |
| Newly installed dependencies | Homebrew `docker-buildx` 0.38.0 and `docker-compose` 5.6.0, each registered in the user's Docker CLI plugin directory. |
| Course VM | New `dsh-course` ARM profile: VZ, 4 CPUs, 8 GiB memory, 60 GiB disk, Docker runtime, no active-context switch. |

## Timeline and failures

| Observation | Cause established | Action and result |
|---|---|---|
| Anonymous repository fetch returned 404. | The requested fork was private. | Read and cloned through the existing authenticated gh CLI; no account or repository permission change was required. |
| First source install printed dependency retries and missing built CLI-link warnings. | Source artifacts did not exist yet; downloads retried successfully. | Kept the frozen lockfile and ran the complete build. No dependency versions or lockfile entries were changed. |
| Native headless OpenRouter request succeeded, but the requested course features were absent. | The manifest contained only base + Web; the ordinary launcher did not mount the trajectory overlay, and no course VM had been provisioned. | Added Scope/Recon bundle selections, switched the Web launcher to the collector preflight, and created the dedicated runtime. |
| Adding a workspace through the embedded browser did not produce a usable native picker. | The native interaction was unsuitable for this embedded-browser setup; its underlying failure was not separately diagnosed. | Persisted the existing documented in-page picker composition in this Web profile. No native-picker source code was changed. |
| Root-directory Python test invocation failed with missing `control`, `manage`, and related modules. | Those stdlib tests import modules relative to `course/scope-runtime`. | Ran the tests from that directory. A separate new Node test was also rerun from the correct repository-root directory. These were invocation corrections, not product fixes. |
| Python 3.14 gateway test failed with `CA cert does not include key usage extension`. | The generated test CA does not satisfy that interpreter's stricter verification. | Python 3.11 passed all 32 gateway unit tests. No CA-generation code or TLS verification flags were changed. |
| First research image build rejected an empty architecture. | Docker's legacy build path did not populate automatic `TARGETARCH`; Buildx was absent. | Installed and registered Buildx, then rebuilt through the native controller. The installer received `arm64` and verified the pinned recon archives. |
| First container verification could not run `docker compose -p ...`. | The separate Compose CLI plugin was absent. | Installed and registered Compose, then reran both isolated container checks successfully. Removed only the failed run's disposable configuration volume and failed build container. |
| Protected configuration would replace the selected OpenRouter provider with OpenAI. | `Manager.configuration()` emitted a later `llm-pi-ai` row containing only OpenAI; the CLI overlay outranked the profile. | Reproduced the lost provider in the built CLI's composed configuration, removed that row, and passed the new regression. |
| A plain localhost URL initially returned an authentication-required response. | The new browser had not exchanged the process's launch token for its cookie. | Used the fresh private login URL printed by the current server. Authentication was retained rather than disabled. |

## Root cause and product fix

The initial acceptance criterion tested the generic source build and one model request. It did not inspect the course-specific profile, sidebar, plugin switches, runtime selector, or isolated workspace. The fork intentionally keeps collection and protected research opt-in, so a successful default launch did not establish that those features were configured.

The independent provider defect was configuration precedence. The generated protected overlay included this row after the research profile:

```json
{"id":"llm-pi-ai","config":{"providers":{"openai":{"apiKeyEnv":"OPENAI_API_KEY"}}}}
```

The local repair removed that row from `course/scope-runtime/manage.py`. PR #10 subsequently replaced the unconditional override with a conditional fallback for explicit OpenAI host-key forwarding when no native model patches are supplied, and added selected model/credential import. The setup PR retains that newer implementation. The gateway still enforces destination policy. The configurable-provider editor's overlay conflict guard explains why editing an overridden provider would also be rejected; the regression directly exercises composed configuration, not an interactive Models save.

The new [model-profile test](../../course/scope-runtime/tests/model-profile.test.mjs) generates the real management overlay with Docker calls mocked, combines it with a private OpenRouter Web profile, and runs the built `dsh web --dump-config`. It failed before the removal and passed afterward. It makes no model request and uses no real credential or Docker daemon.

## Complete change ledger

| Location | Change made during installation | PR treatment |
|---|---|---|
| `course/scope-runtime/manage.py` | Removed the forced OpenAI provider row during installation. | Historical local repair; PR #10 already supplies the newer conditional fallback and feature import. No manager change in this setup PR. |
| `course/scope-runtime/tests/model-profile.test.mjs` | Added the generated-overlay + built-CLI regression described above. | Include as regression coverage for retained behavior. |
| Runtime README pair and pairing record | Documented protected model-provider ownership and required endpoint authorization. | PR #10 owns the updated import behavior; this setup PR replaces the machine-specific runtime-state path with `$DSH_HOME/course-runtime`. |
| `~/.dsh/profiles/web/package.json` | Retained base/Web and added Network Scope and Reconnaissance bundles; backed up the prior manifest first. | Document the selections; never commit an operator's entire home profile. |
| Native Web profile patch | Added OpenRouter via `OPENROUTER_API_KEY`, selected `deepseek/deepseek-v4.1-flash`, disabled DeepSeek session-log upload, selected the in-page picker, and set instructor runtime source/state/Python paths. | Portable examples belong in the guide; private absolute paths and welcome-notice acknowledgement stay local. |
| Native headless profile patch | Configured the same provider/model and disabled DeepSeek session-log upload for CLI checks. | Local configuration only; headless and Web remain separate profiles. |
| `~/.dsh/.env` | Stored only the supplied OpenRouter credential for this setup, with mode 0600 under a mode-0700 home. | Never include the file, value, key-service response, or login tokens. Managed GUI credential storage was not used for this operator-seeded key. |
| Web launch environment | Set `DSH_HOME`, `DSH_COURSE_SOURCE`, and `DSH_TELEMETRY_DISABLED=1`; used umask 077. | Reproducible launch instructions; no global shell startup file was modified. |
| Collector environment | Set collector/projection database paths in separate owner-only directories under `~/.local/share/dsh-course-observation`, plus local installation/student/cohort labels. | Document paths and label semantics. Databases, raw records, and local identity expansions stay private. |
| Web process | Gracefully replaced the ordinary launcher with `course/trajectory-collector/native.mjs`, preserving existing profiles, sessions, workspaces, and loopback binding on port 3080. | The source preflight/overlay already existed; no collector implementation change was required. |
| Docker CLI plugin directory | Added Buildx and Compose symlinks to their Homebrew-installed executables. | Document discovery and missing-plugin failures; do not commit user Docker configuration or registry credentials. |
| Colima | Created the dedicated `dsh-course` VM with only an empty read-only host mount and `--activate=false`. | Document prerequisites and the existing creation command. The active Docker context remained `colima`. |
| Course images | Built `dsh-course-gateway:local` and `dsh-course-research:local`; checksum-pinned Subfinder 2.17.0, URLfinder 0.0.3, DNSx 1.3.1, HTTPx 1.12.0, Naabu 2.6.1, and Katana 1.8.0 were verified. | Images and build caches stay local; the existing manifest owns release versions. |
| Native course draft / applied revision | Added only `openrouter.ai` infrastructure access for GET/POST on `/api/v1/models` and `/api/v1/chat/completions`; saved and applied revision 1. Retained example target domains. | Include a sanitized grant example; no actual assessment target was introduced. |
| Protected home volume | Seeded separate OpenRouter Web/headless profile settings and a mode-0600 key file through an operator-owned, network-disabled container. Copied only the supplied provider key, not the Mac home or its environment. | This was operator automation; the normal guide uses Settings → Models separately in each runtime. Do not commit or distribute the seeded home volume. |
| Protected workspace / UI | Started the gateway and research services; added and selected `/workspace`; verified Protected access mode and enabled Scope/Recon controls. | Explain that this is a named Linux volume, not a mounted Mac workspace. |
| Shared authoring workspace | Installed source under `$VAULT/Agents/Tools/deepseek-harness`; created canonical `$VAULT/Agents/Tools/dsh.sh` and a `~/.local/bin/dsh` symlink. Restored `.claude/{skills,tools}` and `.codex/{skills,tools}` links to shared `Agents/` directories. | Vault-specific integration outside this repository; do not move it into the upstream patch. |
| Shared vault records | Updated `AGENTS-TOOLS.md` and added 3,431 inherited-color Iconize entries for source/build folders, excluding dependency/cache internals. | Vault-specific records outside this repository; no course lecture/lab content was edited. |
| Private diagnostics | Kept local server/build logs, profile backups, PID bookkeeping, and setup screenshots outside the checkout. | Logs can contain launch credentials; use only sanitized summaries in a PR. |

<a id="verification-evidence"></a>
## Verification evidence

These results were observed during this installation. They do not describe a production student enrollment or remote telemetry deployment. Commands below run from the repository root unless they explicitly change directory.

| Check | Observed result |
|---|---|
| `node node_modules/pnpm/bin/pnpm.cjs run build` | 9 gates passed, including native artifacts, host/client compilation and aggregate checks, and Web build. |
| `pnpm exec vitest run packages/guard/scope-judge/tests packages/experimental/course-runtime/tests packages/experimental/recon-projectdiscovery/tests` | 12 files, 260 tests passed. |
| Gateway stdlib tests using Python 3.11, from `course/scope-runtime` | 32 tests passed; the Python 3.14 CA failure is recorded above rather than reported as passing. |
| `node --test course/trajectory-collector/tests/native-profile.test.mjs` | 4 tests passed, including source-record preservation, authenticated inspection, replay after restart, and launcher preflight rejection. |
| `node --test course/scope-runtime/tests/model-profile.test.mjs` | Failed against the forced provider overlay and passed after its removal. |
| Portable guide configuration | A temporary, keyless home initialized its Web profile, composed the documented bundle/YAML/picker examples, and evaluated source/state/Python expressions through the real Loader without starting a listener. |
| `pnpm run test:docs` | 21 gates passed. |
| `pnpm run doc-sync` | 43 gates passed. |
| `pnpm run lint` | Passed with one pre-existing unused-disable warning in the unrelated translation plugin. |
| `git diff --check` | Passed. |
| Native live model request | Exact tool-free control response `DSH_OPENROUTER_OK`, exit 0. |
| Protected live model request | Exact tool-free control response `DSH_PROTECTED_OPENROUTER_OK`, exit 0, through the scoped gateway. |
| Local collector API and GUI | Collected 31 records and projected 5 traces / 31 spans at initial verification; collector and projection cursors agreed, with no remote export destination. |
| Protected runtime API and GUI | Running, healthy gateway, saved/applied revision 1, both custom plugin switches enabled, Protected workspace and model visible. |
| Research container inspection | UID 1000, all capabilities dropped, no-new-privileges, read-only configuration/public mounts, named home/workspace volumes, no Mac home or Docker socket. |

The gateway unit-test invocation was:

```sh
cd course/scope-runtime
PYTHONDONTWRITEBYTECODE=1 python3.11 -m unittest discover -s tests -p 'test_*.py'
cd ../..
```

The isolated built-image and network checks were:

```sh
PYTHONDONTWRITEBYTECODE=1 python3.11 course/scope-runtime/verify.py --context colima-dsh-course --prebuilt
PYTHONDONTWRITEBYTECODE=1 python3.11 course/scope-runtime/tests/image_smoke.py --context colima-dsh-course --image dsh-course-research:local --gateway-image dsh-course-gateway:local
```

Both passed and removed their own disposable projects/volumes. The network suite verified allowed controls and zero forbidden request, connection, and datagram counts across proxy, raw TCP/UDP, IPv4/IPv6, DNS, redirects, Host overrides, Chromium, WebSockets, and nmap. A deliberately broken test firewall rule made its destination counters increase, demonstrating that zero counts were meaningful. Supervisor loss retained denial, and monitor failure terminated the supervisor as PID 1. The image replay separately verified the real course composition and a persisted out-of-scope recon denial without a model key.

## Guardrails and remaining limits

- The setup guide treats visible Trajectories, enabled Scope/Recon, a runtime selector, healthy Protected startup, and separate live provider checks as acceptance steps.
- The composition regression prevents the native manager from replacing the research profile's model provider with a deployment-owned default.
- Dependency discovery checks distinguish Docker, Buildx, and Compose before a first image build or container start.
- The Python 3.14 CA incompatibility remains a follow-up. This work neither fixes certificate extensions nor weakens verification.
- The initial native collector read Local sessions only. PR #10 subsequently added bounded authenticated Protected session-record intake under a separate installation identity. It does not copy attachment binaries or enable remote export, student SSO, or a student uploader.
- Target domains remain `example.test` and `*.lab.test`; target IP grants are empty. The OpenRouter infrastructure exception is operational model access, not assessment authorization.
- Shared-vault launch wrappers, icons, credentials, databases, VM state, generated images, logs, and screenshots are installation artifacts, not upstream source changes.

## Pull request scope

The setup PR targets the post-#10 codebase and adds the built-CLI provider regression, current macOS guide, runtime-state documentation correction, navigation links, and this historical installation record. English/Chinese documentation pairs and their consistency records travel together. The original one-row repair is recorded here, not reapplied over the newer manager. No dependency pin, lockfile, sandbox rule, gateway policy engine, credential protocol, collector implementation, or global default profile is changed by this setup PR. Its current validation belongs in the PR description; the evidence table above remains the initial installation record.
