# Plugin settings

**Engagement and identities** owns the shared target scope, action profile, approvals, engagement budgets and target accounts. The engagement-layer switch lives here. Other plugin pages use the saved engagement rules; they do not have separate scope policies.

**Scoped crawling → Crawl** shows seed URLs, the shared queue, attempted/discovered counts, the latest run result and errors. Adding seeds checks scope without making requests. Start and Stop operate on the same crawl service used by `pentest_crawl`; an agent-started crawl appears here and can be stopped here. Limits cover pages per run, link depth, queue capacity, samples per endpoint template and stopping after pages without new surface. Applying limits stops the current crawl and resets its queue. Limits persist across app restarts; queue and progress are process-local. Shared request/time budgets and action review still apply. **Open shared engagement policy** goes directly to the canonical settings page. The Graph tab shows the shared engagement evidence.

## API keys

Open the plugin's page to save, replace or remove its service keys:

- **ProjectDiscovery recon:** ProjectDiscovery Cloud (`X-API-Key` for the service adapter, `PDCP_API_KEY` for confined ASNMap processes), Chaos (raw `Authorization`), Uncover's Shodan provider and named Subfinder providers. Saving a Subfinder provider enables that source; removing it disables that source. Provider names and paired credentials must use the format supported by the installed Subfinder version. Uncover currently runs Shodan.
- **Telemetry export:** the configured collector, with a bearer token or a custom API-key header. Configure its endpoint first. Saving a key does not enable export.
- **Engagement and identities → Policy:** the optional Jev risk judge's key. Saving the key does not select Jev; the default selected-model judge continues to use the model configured in Models.

Keys live in **macOS Keychain** or **Linux Secret Service**, on the computer running Djupleita. A browser connected to Linux stores them on that Linux host, not in the browser computer's Keychain. Linux needs `libsecret-tools` and an unlocked keyring in the web process's D-Bus session; see [Linux credential storage](linux.md). Missing or locked native storage fails with guidance; there is no plaintext fallback.

The interface only returns configured status and non-secret references. Submitted password fields clear immediately. Values are not returned to the model, placed in plugin settings, passed as command arguments, or retained in trajectories/evidence. Service credentials retain destination bindings, and saving does not grant target scope or auxiliary-service access. The existing service policy still decides access.

CLI tools that require a provider file receive a mode-0600 file in a private run directory during execution; the file is removed after success, failure or cancellation. A process/OS crash can interrupt cleanup. Existing operator-managed `providerConfig` files remain supported; they are not imported or overwritten by this interface. Remove their entries separately if you intend to retire those older credentials.

Settings and references survive restart. Keys are local to the OS secure store and are not bundled into portable releases; moving an engagement to another machine requires re-entering its keys. Third-party model providers remain configured through **Models**.
