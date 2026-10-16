# Domain scope for research courses

English | [中文](scope-judge.zh.md)

The scope judge blocks tool calls to domains outside an instructor-defined scope before their tool bodies execute. Use this guide with a source checkout and the `headless` profile. The [plugin reference](../../../packages/guard/scope-judge/README.md) defines matching, adapters, commands, and enforcement limits.

For browsers, arbitrary scripts, terminals, and IP/CIDR scanning, use the [Linux course runtime](../../../course/scope-runtime/README.md). It keeps capabilities available and enforces network destinations below tool dispatch. This guide describes the separate argument-only judge for restricted structured-tool deployments.

## 1. Prepare the checkout

Install the repository dependencies and build its artifacts from the repository root:

```sh
pnpm install
pnpm run build
```

The build requires a working native compiler. If macOS reports an unaccepted Xcode license and Command Line Tools are already installed, select that compiler for the build:

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools pnpm run build
```

## 2. Set the exercise scope

Edit [scope-judge.patch.yml](../../../apps/cli/config/examples/scope-judge.patch.yml). Replace the reserved example domains in `domains` with the exercise's authorized DNS names. Exact names exclude subdomains; an explicit `*.lab.test` rule includes descendants and excludes `lab.test` itself. List the apex separately when authorized. The patch enables the reviewed `web_fetch` and literal Bash adapters; all unclassified tools are denied.

Keep the patch, plugin, execution environment, and tool implementations outside agent-writable lab files. Mount the judge globally; a guard mounted only within one agent's preset does not govern other agents. Stop current work before changing scope, since the judge checks each new dispatch rather than terminating existing processes.

## 3. Inspect and launch

Inspect the composed configuration without calling a model:

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/scope-judge.patch.yml --dump-config
```

Confirm the `scope-judge` row has the intended domains and that tools use `mode: native`. Configure the profile's model credentials using the [headless reference](../../../packages/bundle/headless/README.md), then start an exercise:

```sh
pnpm dsh --profile headless --patch apps/cli/config/examples/scope-judge.patch.yml 'Inspect the HTTP headers of https://example.test with curl -q -I. Stay within the configured scope.'
```

Replace the example URL with the same authorized lab name configured in step 2. The model-backed exercise requires working model credentials and lab connectivity; the automated verification below is keyless and sends no research traffic.

## 4. Verify denials

Run the judge's focused tests:

```sh
pnpm exec vitest run packages/guard/scope-judge/tests
pnpm run test:snapshot -t scope-judge
```

The tests assert that an in-scope call executes, an outside-domain or mixed-target call never enters its body, force-allow policies cannot override denial, and the Loader activates the plugin. The recorded headless scenario preserves the scope-denial result in Session history. A denial starts with `Error: scope judge denied`; it names the tool and reason and reports the allowed domains.

For additional research tools, follow the [structured adapter requirements](../../../packages/guard/scope-judge/README.md#structured-tools). Keep unknown destinations denied until the tool and all its secondary requests have an enforcement owner. Retain lab egress controls for traffic beyond tool arguments.
