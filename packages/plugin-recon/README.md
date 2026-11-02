# Djupleita · ProjectDiscovery recon

Passive DNS, associated domains, Chaos, exposure statistics and managed ProjectDiscovery tools.

Included with Djupleita. Enable or disable this bundle in **Plugins**. Open its card for configuration and engagement controls. Network scope and effect review remain enforced by the required Djupleita engagement services.

On first use, select **Tool setup → Install recon tools** in this card (or the setup card above the chat input). Djupleita downloads checksum-pinned macOS and Linux releases of subfinder, asnmap, uncover, httpx and Katana and activates them for this engagement. Both arm64 and x64 are supported.

Terminal alternative, from the project directory after `pnpm build`: `pnpm setup:tools --only recon`. Then select **Load local setup** here. **Check tools** checks paths and binary hashes. Local binaries and license notices stay under `.pentest/toolchains/projectdiscovery`; `.pentest/tooling.json` records their paths and hashes. Custom binaries can still be configured in the JSON editor.
