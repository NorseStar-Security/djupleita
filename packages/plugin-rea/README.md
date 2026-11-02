# Djupleita · REA & Ghidra

Offline reverse engineering with REA, macOS and Linux support and configurable Ghidra/JDK runtimes.

Included with Djupleita. Enable or disable this bundle in **Plugins**. Open its card for configuration and engagement controls. Network scope and effect review remain enforced by the required Djupleita engagement services.

Select **Tool setup → Install REA** to install the pinned REA package and a supported, checksum-verified Node runtime under `.pentest/toolchains`. This preserves selected analysis roots and Ghidra/JDK settings. It does not register REA with other coding clients or install its global skill. Terminal alternative, after `pnpm build`:

```sh
pnpm setup:tools --only rea
```

Then select **Load local setup**. **Check tools** checks Node compatibility; an old executable is shown as **Needs setup**. `pentest_rea_doctor` reports selected roots, artifact inventory readiness and native engine diagnostics. Ghidra checks use an explicit provider scope, so missing unselected engines and external-client skills are informational.

Before invoking REA, search the live catalog with `pentest_rea_catalog({"query":"archive"})`, then request the exact schema with `pentest_rea_catalog({"tool":"open_binary"})`. Catalog results are paged; they do not inject every tool's full schemas into the conversation. For unusually large input schemas, `schemaPath` selects a branch, such as `["properties", "path"]`.

For a DMG or archive, use these advertised REA calls through `pentest_rea`. Paths must be within the owner's selected `rea.roots`. Copy an input into the default `.pentest/analysis` directory or add its exact path in plugin configuration.

```json
{"tool":"open_binary","arguments":{"path":"/absolute/path/within/selected/roots/installer.dmg"}}
```

```json
{"tool":"inspect_artifact","arguments":{"detail":"summary"}}
```

The summary retains complete local Evidence. Search the catalog for `inspect_analysis_view` to read selected inventory pages, then call `close_binary` when finished. On macOS, DMG inventory uses a read-only mount and detaches it during cleanup. It does not execute an installer. Artifact inventory works without a decompiler; analysis of a native executable needs a configured engine. An installer does not establish the identity of a running application.

For Ghidra, select a full host-native JDK and an extracted Ghidra installation:

```sh
pnpm setup:tools --only rea \
  --ghidra /absolute/path/to/ghidra \
  --java-home /absolute/path/to/jdk/Contents/Home
```

Ghidra 12.1.4 works with JDK 21. Its official archive lacks a macOS native decompiler. Build it from the included source using Apple's Command Line Tools. On Apple silicon, run these commands from `Ghidra/Features/Decompiler/src/decompile/cpp` inside that installation:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools \
  make -j4 ghidra_opt ARCH_TYPE='-arch arm64' ADDITIONAL_FLAGS='-mmacosx-version-min=15.0'
mkdir -p ../../../os/mac_arm_64
cp ghidra_opt ../../../os/mac_arm_64/decompile
```

For Intel, use `-arch x86_64` and `mac_x86_64`. Run `pentest_rea_doctor` after loading the configuration; it verifies the decompiler header, JVM architecture and supported Java version. The confined integration permits the selected JDK bundle metadata and its individually resolved native library dependencies. It uses a privately signed copy of the system process-list utility without setuid privileges and keeps caches in its private workspace. The Ghidra bridge communicates over a private Unix socket; direct Internet sockets remain blocked. Gatekeeper and system security settings remain active.
