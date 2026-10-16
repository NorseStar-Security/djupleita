# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Security research in this fork

This fork adds scoped red-team research, reconnaissance, optional security callbacks, and trajectory inspection. **Network Scope** and **Reconnaissance** are first-party entries in **Plugins → Configure** and remain experimental. The upstream documentation above describes the base harness; the guides below describe this fork's additions.

### Local and Protected workspaces

The **Research runtime** selector above the workspace browser reconnects the complete client, including sessions, plugins, terminals, files, and streams.

| | Local | Protected |
|---|---|---|
| Execution | Native Mac backend and its filesystem | Separate Linux backend in the dedicated ARM `dsh-course` Colima VM |
| Network enforcement | The course gateway does not constrain Mac processes | Domain/IP policy enforced by the gateway and Linux firewall |
| Files and sessions | Native backend's storage | Named home/workspace volumes; no Mac workspace or Docker socket mounted |
| Model configuration | Local **Settings → Models** | Saved Local model routes and API keys are imported on apply; Protected **Settings → Models** can override them |

Switching reconnects the same browser tab, retains separate session selections and browser state, and leaves background work running. Sessions and files do not migrate. An unavailable Protected backend shows recovery controls and cannot silently run work on Local. Scope and Recon management remains on the native host from either selection.

One protected environment shares one policy across sessions. Research runs as UID 1000 with dropped capabilities and read-only system/configuration mounts. See the [runtime guide](course/scope-runtime/README.md) for deployment, enforcement details, and limitations.

### Red-team plugins

| Feature | Purpose and configuration |
|---|---|
| Network Scope | Authorize target domains/IPs, exclusions, and limited infrastructure requests; inspect applied policy and gateway status. Open **Plugins → Network Scope → Configure**; [policy reference](course/scope-runtime/README.md#policy-reference). |
| Reconnaissance | Passive discovery with Subfinder/URLfinder; explicit DNSx, HTTPx, Naabu, and Katana operations. Open **Plugins → Reconnaissance → Configure**; [sources and execution limits](packages/experimental/recon-projectdiscovery/README.md). |
| Scope judge | Check reviewed tool arguments before execution in an explicitly composed profile. This is an [argument-only guard](packages/guard/scope-judge/README.md); arbitrary browser/terminal traffic requires Protected network enforcement. |
| Security callbacks | Allocate expiring HTTP(S) callback URLs, read bounded evidence, and revoke them. Use an opt-in profile overlay with an authenticated ngrok agent or custom tunnel; [callback setup](packages/experimental/security-callbacks-ngrok/README.md). No default profile publishes a public endpoint. |
| Trajectories | Inspect collected sessions and traces; optionally export approved records. See [native collector setup](course/trajectory-collector/README.md). When native collection is configured, the native controller also reads Protected session records into the archive under a separate installation identity. |

Callback hits and discovered assets are evidence, not authorization. Discovery never expands scope. The default passive sources, crt.sh and Wayback, need no API keys; the shipped/reset policy includes their limited network permissions. Existing saved policies retain their explicit grants. Credential-backed passive sources do not yet have a supported key-entry flow; see [Recon authentication limits](packages/experimental/recon-projectdiscovery/README.md#use-this-package).

### Start a protected exercise

1. Use this fork's source checkout. Follow the [Mac runtime setup](course/scope-runtime/README.md#run-an-exercise) for the separate Colima profile and ARM image; it explicitly targets the course Docker context.
2. Enable **Network Scope** and **Reconnaissance** in Plugins. Configure authorized targets, exclusions, infrastructure permissions, and recon budgets. Domain grants do not authorize raw-IP scanning; grant those IPs/CIDRs separately.
3. **Save** stages a pending revision; **Apply** activates it. A running environment requires **Stop and apply**, interrupting research processes. Failed apply leaves research stopped while preserving sessions, volumes, and saved drafts. Leaving a page discards unsaved edits. Stop the runtime before disabling/removing either bundle.
4. Apply the runtime, then select **Protected**. Saved Local model routes and their product-stored API keys are inherited; use **Settings → Models** in Protected for overrides. Authorize the model endpoint in Network Scope as well: a key does not grant network access. Host `OPENAI_API_KEY` forwarding is explicit and optional; the full host environment and credential store are not copied. Telemetry remains disabled.
5. Ask the agent to inspect `scope_status` and `recon_catalog` before research. Use `recon_run` only with authorized targets; active operations additionally require explicit `allowActive` consent. Review coverage flags and denials before selecting further targets. The runtime guide also provides keyless checks for testing before a model is configured.

If Web authentication is required, reopen the login URL printed by `dsh web`. Keep login tokens and model credentials out of repository files and transcripts.

## Run

### Run from `npm`

For the upstream base harness, install `Node.js`, then run the following. This does not install this fork's research additions:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/5stars217/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

For a complete Apple Silicon deployment, follow [course setup on macOS](docs/user/guide/course-macos.md).

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
