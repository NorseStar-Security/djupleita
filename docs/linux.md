# Linux web interface

Djupleita runs on Linux through `pnpm web`. Managed releases cover glibc Linux x64 and arm64. The desktop launcher remains macOS-only; native Windows is unsupported. Use a dedicated local checkout and a regular user account.

## Install

Debian 12 / Ubuntu 22.04 or newer, Node 24.9+, pnpm 10.32.1 and Git are required. Install system dependencies with your distribution's package manager:

```sh
sudo apt-get update
sudo apt-get install build-essential bubblewrap curl unzip zip python3 python3-venv libsecret-tools dbus-user-session gnome-keyring
pnpm bootstrap
npx --yes pnpm@11.28.5 --dir vendor/deepseek-harness install --frozen-lockfile --ignore-scripts
pnpm build:harness
pnpm install --frozen-lockfile
pnpm build
node packages/browser/node_modules/playwright/cli.js install-deps chromium
pnpm setup:tools --only browser
pnpm setup:tools --only recon
pnpm setup:tools --only ffuf
pnpm web
```

Run these commands from the repository root. Playwright's `install-deps` installs distribution packages and may request sudo. The Chromium download and managed tools stay under `.pentest/toolchains/`. Linux does not need `pnpm build:keychain` or Electron installation. Follow [SECURITY.md](../SECURITY.md) to install the scanner/hooks and privately provision confidential-reference rules before publishing changes.

The launcher prints a loopback URL. To use a remote Linux machine, choose a fixed port with `DSH_PENTEST_PORT=19876 pnpm web`, then forward it with `ssh -L 19876:127.0.0.1:19876 user@linux-host` and open the authenticated loopback URL printed at startup through that tunnel. Keep this single-user interface on loopback; it is not a public multi-user service. Configure models and targets in the same interface used on macOS. Do not run two writers against one engagement.

## Isolation

Workers use the distribution's `/usr/bin/bwrap`, with private user, PID, mount and network namespaces, dropped capabilities, a minimal filesystem, read-only selected inputs and explicit writable workspaces. Host home directories, host temporary files and the session D-Bus are absent. Existing host Unix sockets in input mounts are hidden unless a private IPC root was explicitly granted. Use dedicated artifact directories rather than directories where other services create live IPC endpoints. A worker's `/tmp` is private. Offline analysis and learning have no host-network route.

Network-enabled workers receive one private Unix-socket bridge to their scoped host broker. A relay recreates the broker's loopback endpoint inside the private network namespace. The broker continues to enforce authentication, scope, DNS pinning, request budgets, cancellation and trajectory recording. Chromium runs offline; its intercepted requests pass through the HTTP broker. No unrestricted network fallback is provided.

Check namespace support before using managed tools:

```sh
/usr/bin/bwrap --unshare-all --ro-bind / / -- /bin/true
```

If this fails, use your distribution's supported Bubblewrap/user-namespace configuration. Recent Ubuntu versions require an AppArmor profile permitting user namespaces for Bubblewrap; see the [Ubuntu release notes](https://documentation.ubuntu.com/release-notes/24.04/). Restricted containers and hardened hosts may prohibit namespace creation. Install/configure the supported backend instead of removing confinement flags or running the web app as root. The plugin dependency view checks that Bubblewrap exists; actual launch also verifies that the host permits its namespaces.

## Identity credentials

macOS keeps using Keychain. Linux uses `secret-tool` and the Secret Service keyring in the web process's user D-Bus session. The keyring must be running and unlocked. Secret values travel on stdin/stdout, never command arguments; multiline browser-state data is encoded before storage. Credential failures stop the operation and do not fall back to plaintext files. Identity metadata and credential host bindings are unchanged. Model-provider credentials remain managed separately by Harness.

A graphical login normally supplies the session bus and unlocks the login keyring. For a headless host, start a private user session and unlock its encrypted keyring interactively before launching the app, for example:

```sh
dbus-run-session -- bash
# In that shell; read the existing keyring password without echoing it:
read -r -s -p 'Keyring password: ' djupleita_keyring_password
printf '\n'
printf '%s' "$djupleita_keyring_password" | gnome-keyring-daemon --unlock --components=secrets
unset djupleita_keyring_password
pnpm web
```

Use the same user session for the daemon and web process. Provision the encrypted keyring for that account first; do not create an unencrypted keyring for unattended use. An unavailable/locked keyring affects identity operations, while the rest of the web interface remains available.

## Optional tools

`pnpm setup:tools --only rea` installs pinned REA and its own supported Node runtime. Archive inventory and static analysis run offline. Native decompilation needs Linux Ghidra and a matching Linux JDK:

```sh
pnpm setup:tools --only rea --ghidra /absolute/ghidra --java-home /absolute/jdk --analysis-root /absolute/inputs
```

Use **Load local setup** in Pentest → Plugins after terminal installation, then run `pentest_rea_doctor`. macOS DMG mounting and Apple-specific analysis utilities remain platform-specific. Linux Ghidra must include its `linux_x86_64` or `linux_arm_64` decompiler.

`pnpm setup:tools --only learning` uses `/usr/bin/python3` and `python3-venv` on Linux; `--python /absolute/python3` overrides it. Python workers receive neither provider credentials nor direct network access.

## Validation

Run `pnpm typecheck`, `pnpm build`, and the focused tests below as a normal Linux user with Bubblewrap and Chromium installed:

```sh
pnpm exec vitest run tests/fuzz.test.ts tests/worker.test.ts tests/linux-platform.test.ts tests/secret-service.test.ts tests/browser.test.ts tests/toolchain-setup.test.ts tests/ffuf-setup.test.ts tests/rea-setup.test.ts tests/rea.test.ts tests/rea-linux.test.ts tests/learning.test.ts tests/issue-regressions.test.ts tests/additive-modes.test.ts tests/profile.test.ts tests/model-egress.test.ts tests/replay.test.ts packages/dsh-plugin/src/integration.test.ts
```

The Secret Service round-trip is opt-in (`DSH_TEST_SECRET_SERVICE=1`). Use a disposable session bus/keyring for that check. The default provider tests use a synthetic helper and never touch an existing keyring. Tests use local fixtures; no real model calls or target scans are required.

See [Target scope and destination allowances](scope.md) for the editable scope example, saved host approvals, and setup reminder controls shared with macOS.

Run `DSH_TEST_WEB_UI=1 pnpm exec vitest run tests/web-issues.test.ts` after building the harness and installing Playwright Chromium to exercise the authenticated scope, approval and setup controls. CI runs these checks on Linux and macOS.
