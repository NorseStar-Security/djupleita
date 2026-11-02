# Linux web interface

Djupleita runs on Linux through `pnpm web`. Managed releases cover glibc Linux x64 and arm64. The desktop launcher remains macOS-only; native Windows is unsupported. Use a dedicated local checkout and a regular user account.

## Install

Follow the [Linux install instructions in the README](../README.md#linux-browser-interface) for system packages, the pinned package-manager commands, build order, browser/tool installation and launch. The README also lists common startup errors and remote access through SSH. The Chromium download and managed tools stay under `.pentest/toolchains/`. Follow [SECURITY.md](../SECURITY.md) to install the scanner/hooks and privately provision confidential-reference rules before publishing changes.

### Node and package managers

Use a full Node 24 LTS installation (24.9+) for the Linux architecture, including npm and matching development headers. The native build finds headers relative to the actual `node` executable, so a copied standalone executable or an unrelated system `libnode-dev` package may leave it unable to build. This check prints the required header path or fails before a long build:

```sh
node --version
node --input-type=module <<'NODE'
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const header = resolve(dirname(process.execPath), '../include/node/node_api.h');
if (!existsSync(header)) throw new Error('Missing ' + header + '; install the full matching Node distribution.');
console.log('Node-API headers: ' + header);
NODE
```

The root workspace declares pnpm 10.32.1; `vendor/deepseek-harness` declares pnpm 11.28.5. Use the README's explicit `npx --yes pnpm@11.28.5 --dir vendor/deepseek-harness ...` command for the latter. Use a user-owned Node installation if global npm installation reports `EACCES`. Registry timeouts can make first installation slow; retry the failed pinned install instead of editing lockfiles or disabling checks.

Use a separate Linux checkout and install its dependencies there. Copying macOS `node_modules` or native build outputs into Linux does not produce a Linux installation. Keep runtime state and credentials local to each test installation. Stop the app with **Ctrl+C** in its launch terminal before restarting; do not run two writers against one engagement.

## Isolation

Workers use the distribution's `/usr/bin/bwrap`, with private user, PID, mount and network namespaces, dropped capabilities, a minimal filesystem, read-only selected inputs and explicit writable workspaces. Host home directories, host temporary files and the session D-Bus are absent. Existing host Unix sockets in input mounts are hidden unless a private IPC root was explicitly granted. Use dedicated artifact directories rather than directories where other services create live IPC endpoints. A worker's `/tmp` is private. Offline analysis and learning have no host-network route.

Network-enabled workers receive one private Unix-socket bridge to their scoped host broker. A relay recreates the broker's loopback endpoint inside the private network namespace. The broker continues to enforce authentication, scope, DNS pinning, request budgets, cancellation and trajectory recording. Chromium runs offline; its intercepted requests pass through the HTTP broker. No unrestricted network fallback is provided.

Check namespace support before using managed tools:

```sh
/usr/bin/bwrap --unshare-all --ro-bind / / -- /bin/true
```

If this fails, use your distribution's supported Bubblewrap/user-namespace configuration. The plugin dependency view checks that Bubblewrap exists; actual launch also verifies that the host permits its namespaces.

### Bubblewrap on Ubuntu 24.04

Ubuntu 24.04 restricts unprivileged user namespaces through AppArmor. A missing Bubblewrap permission can cause `setting up uid map: Permission denied`, `loopback: Failed RTM_NEWADDR: Operation not permitted`, or namespace-creation errors. See Ubuntu's [user-namespace restrictions and application-profile example](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions).

Check existing policy with your administrator first. Prefer the distribution's supported Bubblewrap profile; do not add a second profile matching `/usr/bin/bwrap` or replace an existing policy. If no matching profile exists, this application-specific example was exercised on the Ubuntu 24.04 test VM:

```sh
sudo sh -eu <<'SH'
test ! -e /etc/apparmor.d/djupleita-bwrap
cat > /etc/apparmor.d/djupleita-bwrap <<'PROFILE'
abi <abi/4.0>,
include <tunables/global>

profile djupleita-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
PROFILE
apparmor_parser -a /etc/apparmor.d/djupleita-bwrap
SH
/usr/bin/bwrap --unshare-all --ro-bind / / -- /bin/true
```

This permits Bubblewrap to create namespaces; its filesystem, PID and network sandbox remains required. Keep AppArmor and system-wide namespace restrictions enabled. Run the final check as the regular app user.

### Containers and hardened hosts

Container seccomp/AppArmor policies, masked `/proc` mounts or host namespace limits can still deny Bubblewrap even when it is installed. `Can't mount proc` and `Operation not permitted` can indicate these outer restrictions. A normal Linux VM avoids an additional container sandbox for local testing. On a managed host, have its administrator provide the required namespace support; do not use privileged containers, drop confinement flags or run the app as root as an installation workaround.

Workers mount runtime binaries, libraries, certificates, fonts and other selected system data. They do not automatically expose all of `/usr`, its documentation or unrelated SDKs. Select any additional SDK or analysis data through the tool's explicit input roots. Standard system Python and Node prefixes reuse these runtime mounts.

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

Every managed tool group supports glibc Linux x64 and arm64: recon (subfinder, asnmap, uncover, httpx, Katana), ffuf, Playwright Chromium, REA and Python learning. The three install buttons use the Linux backend's architecture. Browser and learning setup use the terminal commands in the README. Release manifests require checksum pins for both Linux architectures as well as both macOS architectures.

An error saying installation supports only macOS identifies an older backend. Update the source to a revision with the Linux adapters, run `pnpm install --frozen-lockfile` and `pnpm build`, stop the old `pnpm web` process, and relaunch it. Keep `.pentest/`; re-run setup and select **Load local setup** to activate the verified installation.

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

After recon setup, `DSH_TEST_RECON_CONFIG="$PWD/.pentest/tooling.json" pnpm exec vitest run tests/toolchain-setup.test.ts` also executes the version command of every installed recon binary in an offline sandbox. CI installs and checks these binaries on Linux and macOS; installer fixtures cover all four OS/architecture combinations.

See [Target scope and destination allowances](scope.md) for the editable scope example, saved host approvals, and setup reminder controls shared with macOS.

Run `DSH_TEST_WEB_UI=1 pnpm exec vitest run tests/web-issues.test.ts` after building the harness and installing Playwright Chromium to exercise the authenticated scope, approval and setup controls. CI runs these checks on Linux and macOS.
