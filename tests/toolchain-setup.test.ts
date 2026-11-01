import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installReconTools, ReconToolSchema } from '../packages/recon/src/index.ts';
import { PentestRuntime, PluginConfigSchema } from '../packages/dsh-plugin/src/runtime.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-tool-setup-')); directories.push(root);
  await mkdir(join(root, 'configs')); await mkdir(join(root, 'fixture'));
  for (const tool of ReconToolSchema.options) await writeFile(join(root, 'fixture', tool), `#!/bin/sh\n# local ${tool} fixture; never executed\nexit 0\n`);
  await writeFile(join(root, 'fixture/LICENSE.md'), 'Local test fixture license');
  execFileSync('/usr/bin/zip', ['-q', 'release.zip', ...ReconToolSchema.options, 'LICENSE.md'], { cwd: join(root, 'fixture') });
  const archive = await readFile(join(root, 'fixture/release.zip'));
  const hash = createHash('sha256').update(archive).digest('hex');
  const tools = Object.fromEntries(ReconToolSchema.options.map(tool => [tool, { version: '1.2.3',
    checksums: `https://github.com/projectdiscovery/${tool}/releases/download/v1.2.3/checksums.txt`,
    assets: Object.fromEntries(['darwin-arm64', 'darwin-x64'].map(platform => [platform, {
      url: `https://github.com/projectdiscovery/${tool}/releases/download/v1.2.3/${tool}_1.2.3_macOS_${platform.endsWith('arm64') ? 'arm64' : 'amd64'}.zip`, sha256: hash,
    }])),
  }]));
  const lock = { schemaVersion: 1, tools };
  const saveLock = () => writeFile(join(root, 'configs/recon-tools.lock.json'), JSON.stringify(lock));
  await saveLock();
  const download = vi.fn(async () => new Response(archive)); vi.stubGlobal('fetch', download);
  return { root, lock, saveLock, download };
}

it('installs all locked binaries with notices, reuses verified copies and rejects local tampering', async () => {
  const f = await fixture();
  const installed = await installReconTools(f.root, new AbortController().signal);
  expect(f.download).toHaveBeenCalledTimes(5);
  for (const tool of ReconToolSchema.options) {
    const binary = installed[tool];
    expect(createHash('sha256').update(await readFile(binary.path)).digest('hex')).toBe(binary.sha256);
    expect((await stat(binary.path)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(binary.path, '../LICENSE.txt'), 'utf8')).toContain('Local test fixture license');
  }
  f.download.mockClear();
  expect(await installReconTools(f.root, new AbortController().signal)).toEqual(installed);
  expect(f.download).not.toHaveBeenCalled();
  await writeFile(installed.subfinder.path, 'tampered');
  await expect(installReconTools(f.root, new AbortController().signal)).rejects.toThrow('integrity check');
  expect(f.download).not.toHaveBeenCalled();
});

it('rejects a mismatched archive before any executable is installed', async () => {
  const f = await fixture();
  for (const asset of Object.values(f.lock.tools.subfinder!.assets)) asset.sha256 = '0'.repeat(64);
  await f.saveLock();
  await expect(installReconTools(f.root, new AbortController().signal)).rejects.toThrow('pinned SHA-256');
  expect(f.download).toHaveBeenCalledTimes(1);
});

it('refuses an alternate download host even if its checksum matches', async () => {
  const f = await fixture();
  for (const asset of Object.values(f.lock.tools.subfinder!.assets)) asset.url = 'https://example.test/subfinder.zip';
  await f.saveLock();
  await expect(installReconTools(f.root, new AbortController().signal)).rejects.toThrow('official release URL');
  expect(f.download).not.toHaveBeenCalled();
});

it('loads terminal-installed tools into an existing engagement, refreshes readiness and persists them', async () => {
  const f = await fixture(), session = id<'SessionId'>();
  const config = { engagement: engagement(), policy: policyConfig, root: join(f.root, 'engagements'), keychainHelper: '/unused', distributionRoot: f.root };
  const runtime = await PentestRuntime.open(config, testJudge);
  try {
    expect((await runtime.toolSetup()).entries.filter(entry => entry.group === 'recon').every(entry => entry.status === 'missing')).toBe(true);
    await runtime.updatePlugins(PluginConfigSchema.parse({ browser: { headless: false }, recon: { binaries: {}, sources: ['crtsh'], timeoutMs: 60000 } }), session);
    const binaries = await installReconTools(f.root, new AbortController().signal);
    await writeFile(join(f.root, '.pentest/tooling.json'), JSON.stringify({ recon: { binaries } }));
    await runtime.loadLocalSetup(session);
    const ready = await runtime.toolSetup();
    expect(ready.installAvailable).toBe(true);
    expect(ready.entries.filter(entry => entry.group === 'recon').every(entry => entry.status === 'ready')).toBe(true);
    const saved = JSON.parse(await readFile(join(runtime.root, 'plugins.json'), 'utf8'));
    expect(saved.browser.headless).toBe(false); expect(saved.recon.timeoutMs).toBe(60000); expect(saved.recon.binaries).toEqual(binaries);
  } finally { await runtime.close(); }
  const reopened = await PentestRuntime.open(config, testJudge);
  try { expect((await reopened.toolSetup()).entries.filter(entry => entry.group === 'recon').every(entry => entry.status === 'ready')).toBe(true); }
  finally { await reopened.close(); }
});

it('installs through the owner runtime action and records activated configuration', async () => {
  const f = await fixture(), session = id<'SessionId'>();
  const runtime = await PentestRuntime.open({ engagement: engagement(), policy: policyConfig, root: join(f.root, 'engagements'), keychainHelper: '/unused', distributionRoot: f.root }, testJudge);
  try {
    await runtime.installRecon(session, new AbortController().signal);
    expect((await runtime.toolSetup()).entries.filter(entry => entry.group === 'recon').every(entry => entry.status === 'ready')).toBe(true);
    expect(Object.keys(JSON.parse(await readFile(join(f.root, '.pentest/tooling.json'), 'utf8')).recon.binaries)).toHaveLength(5);
    expect((await runtime.trajectories.read(session)).some(event => event.type === 'plugins/settings')).toBe(true);
  } finally { await runtime.close(); }
});
