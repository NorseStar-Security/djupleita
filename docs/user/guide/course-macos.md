---
description: "Set up this fork's course features on Apple Silicon macOS: mandatory trajectories and action review, Scope and Recon plugins, an isolated Colima workspace, and imported OpenRouter settings."
---

# Set up the course fork on macOS

English | [中文](course-macos.zh.md)

## Summary

Use this source checkout to run the course Web app with local trajectories, action review, Network Scope, Reconnaissance, and an isolated Linux workspace. The course host is management-only by default; research requires a configured, ready isolated runtime. The ordinary Web profile does not enable all these features. This guide covers the Apple Silicon deployment; [the installation report](../../postmortem/0005-course-macos-setup.md) records its historical setup evidence.

## Table of Contents

- [Build the fork](#build-the-fork)
- [Configure the private Web profile](#configure-the-private-web-profile)
- [Prepare Docker and Colima](#prepare-docker-and-colima)
- [Launch with local trajectories](#launch-with-local-trajectories)
- [Start isolated research and configure OpenRouter](#start-protected-and-configure-openrouter)
- [Verify and recover](#verify-and-recover)

<a id="build-the-fork"></a>
## Build the fork

Provide Git, access to this repository, Node.js satisfying `package.json`, pnpm, and working Xcode Command Line Tools. The repository declares pnpm 11.28.5. Provide Python 3.11 on PATH for the native controller and gateway tests; the installation report describes the unresolved Python 3.14 test-CA incompatibility. The [root source instructions](../../../README.md#run-from-source) own the build procedure.

For the course fork used by this guide:

```sh
gh repo clone 5stars217/deepseek-harness
cd deepseek-harness
pnpm install --frozen-lockfile
node node_modules/pnpm/bin/pnpm.cjs run build
```

The final command uses the pnpm version installed by the workspace. A private repository requires an authenticated account with read access. Running the published npm package does not install this checkout's unreleased course changes. Dependency retries and missing `lib/bin.js` link warnings before the first build do not establish a failed application build; inspect the completed command's exit status.

<a id="configure-the-private-web-profile"></a>
## Configure the private Web profile

Keep configuration and credentials outside the checkout and any shared vault. Retain these exports in the shell or launcher that starts the app:

```sh
export DSH_HOME="$HOME/.dsh"
export DSH_COURSE_SOURCE="$PWD"
export DSH_COURSE_PYTHON="$(command -v python3.11)"
export DSH_TELEMETRY_DISABLED=1
umask 077
mkdir -p "$DSH_HOME"
pnpm dsh web --dump-config > /dev/null
```

The dump initializes the Web profile without starting a listener or calling a model. In `$DSH_HOME/profiles/web/package.json`, retain existing dependencies and bundles and include these four bundles in order:

```json
[
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  "@deepseek-ai/dsh-experimental-network-scope-bundle",
  "@deepseek-ai/dsh-experimental-recon-bundle"
]
```

This array is the manifest's `dsh.profile.bundles` value, not a replacement for the whole manifest. The same Scope and Recon bundles can be enabled through Plugins in an already running app. Preserve existing profile rows when adding the following configuration to `$DSH_HOME/profiles/web/cordis.patch.yml`; a row's `config` replaces that row's complete configuration, so retain other providers if already configured:

```yaml
- id: llm-pi-ai
  config:
    providers:
      openrouter:
        displayName: OpenRouter
        apiKeyEnv: OPENROUTER_API_KEY
- id: agent-default-model
  config:
    provider: openrouter
    model: deepseek/deepseek-v4.1-flash
- id: session-log-deepseek
  config:
    enabled: false
- id: course-runtime
  config:
    role: instructor
    sourceRoot: !!js process.env.DSH_COURSE_SOURCE
    stateRoot: !!js dshHomePath('course-runtime')
    python: !!js process.env.DSH_COURSE_PYTHON
```

No API key belongs in this YAML. Configure credentials after launch through [Settings → Models](providers.md). The OTel switch and the DeepSeek session-log switch control separate upload paths; this local deployment disables both.

For an embedded browser, the documented [in-page picker overlay](../../../apps/web/tests/pin-browse-picker.overlay.yml) avoids a native OS chooser. To keep that interaction in the Web profile, append its disable-and-insert rows to the profile patch. The native OS picker remains available in other profiles.

<a id="prepare-docker-and-colima"></a>
## Prepare Docker and Colima

Provide Docker and Colima, then install the separate Homebrew CLI plugins if absent:

```sh
brew install docker-buildx docker-compose
mkdir -p "$HOME/.docker/cli-plugins"
```

Register the installed executables as `$HOME/.docker/cli-plugins/docker-buildx` and `$HOME/.docker/cli-plugins/docker-compose`. In this Homebrew layout they point to `$(brew --prefix docker-buildx)/bin/docker-buildx` and `$(brew --prefix docker-compose)/bin/docker-compose`. Preserve existing registrations. Confirm discovery before building images:

```sh
docker buildx version
docker compose version
```

Docker alone is insufficient: the legacy builder did not populate the Dockerfile's automatic `TARGETARCH` argument, and the recon installer rejected an empty architecture. Missing Compose prevented container startup. The [course runtime instructions](../../../course/scope-runtime/README.md#run-an-exercise) provide the dedicated Colima creation command. Use its `dsh-course` profile and `--activate=false`; the application targets `colima-dsh-course` without changing the active Docker context.

<a id="launch-with-local-trajectories"></a>
## Launch with local trajectories

The collector needs separate owner-only database directories outside `DSH_HOME`, plus explicit local archive labels. Example labels below are local operator metadata, not course enrollment or SSO claims:

```sh
export COURSE_COLLECTOR_DB="$HOME/.local/share/dsh-course-observation/collector/trajectories.sqlite"
export COURSE_PROJECTION_DB="$HOME/.local/share/dsh-course-observation/projection/traces.sqlite"
export COURSE_INSTALLATION_ID="sans-local-${USER}"
export COURSE_STUDENT_ID="local-instructor"
export COURSE_COHORT_ID="local-development"
mkdir -p "$(dirname "$COURSE_COLLECTOR_DB")" "$(dirname "$COURSE_PROJECTION_DB")"
chmod 700 "$(dirname "$COURSE_COLLECTOR_DB")" "$(dirname "$COURSE_PROJECTION_DB")"
node course/trajectory-collector/native.mjs web --host 127.0.0.1 --port 3080 --no-open
```

Use the fresh login URL printed by the process; visiting the bare localhost URL before authentication produces an authentication-required response. Keep launch URLs and tokens private. Stop an existing owner gracefully before replacing the listener; do not start a second process on its port. The [collector reference](../../../course/trajectory-collector/README.md#integrated-local-web-app) owns preflight checks, archive placement, and collection limits.

Confirm **Trajectories** appears on the host and has indexed records. Confirm **Network Scope** and **Reconnaissance** are enabled under Plugins and the **Research runtime** selector distinguishes **Host management** from **Isolated Linux**. Incomplete setup opens Network Scope rather than falling back to host research. A working ordinary chat alone does not verify the course configuration.

<a id="start-protected-and-configure-openrouter"></a>
## Start isolated research and configure OpenRouter

Open **Plugins → Network Scope → Configure**. Build the ARM runtime, then configure the authorized exercise policy. Keep the reserved example target domains until actual lab targets are supplied. For OpenRouter, add this entry to the existing infrastructure JSON without removing other required entries:

```json
{
  "openrouter.ai": {
    "methods": ["GET", "POST"],
    "paths": ["/api/v1/models", "/api/v1/chat/completions"]
  }
}
```

Before Apply, configure **Action review configuration (JSON)** with an explicit reviewer model and credential reference using the [action-review instructions](../../../course/scope-runtime/README.md#action-review). Configure its referenced credential on the trusted host. Reviewer keys go only to the gateway, not the research container. Empty reviewer models, missing credentials, or unavailable local collection prevent research startup. The [review migration](../../upgrade-guide/v0.2.1-alpha.3/course-action-review/guide.md) covers existing installations.

Save the pending configuration and Apply. A running environment requires **Stop and apply**. Apply imports enabled native bundles, research model settings, and their referenced product-stored API keys into the separate isolated home. Later applies refresh inherited values while retaining deliberate isolated model edits and unrelated credentials. Environment-only research keys and account sign-ins require separate configuration; optional host-key forwarding covers only `OPENAI_API_KEY`. Wait for **running**, healthy gateway enforcement, ready action review and collection, and matching saved/applied revisions. Select **Research runtime → Isolated Linux** and verify its provider/model in **Settings → Models**; enter an isolated research credential there if it was not imported.

Add and select `/workspace` in the isolated workspace picker. It is a named Docker volume, not a Mac directory. Switching runtimes does not migrate host workspaces or sessions. Local collection is mandatory: the native controller pulls bounded authenticated isolated session-record pages into the collector under a separate installation identity. Isolated research receives the viewer without native cookies or collector write credentials. Attachment binaries are not copied; inspect archive errors and collection/projection progress as described in the collector reference. No remote exporter or student uploader is installed by this guide.

<a id="verify-and-recover"></a>
## Verify and recover

Use the [runtime verification](../../../course/scope-runtime/README.md#verify-the-boundary), [native collector checks](../../../course/trajectory-collector/README.md#verification), and [installation evidence](../../postmortem/0005-course-macos-setup.md#verification-evidence). The protected-provider regression runs from the repository root:

```sh
node --test course/scope-runtime/tests/model-profile.test.mjs
```

Send a short, tool-free test prompt in each runtime to validate live model access separately from keyless replay. Validate the actual scope controls before a real assessment. The installation report distinguishes these checks and their results.

If an image build fails, read `$DSH_HOME/course-runtime/build.log`, repair the dependency or configuration error, and choose **Build ARM runtime** again. Preserve the named home/workspace volumes. If model requests fail, check both the selected runtime's credential and the policy's provider-endpoint grant. Do not disable TLS verification to work around the Python test-CA issue.

## Dev Note

None.
