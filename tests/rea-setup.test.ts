import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installReaNode, installRea } from '../packages/rea/src/install.ts';
import { PentestRuntime, PluginConfigSchema } from '../packages/dsh-plugin/src/runtime.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-rea-setup-')); directories.push(root);
  const platform = `darwin-${process.arch}`, prefix = `node-v24.22.1-${platform}`;
  await mkdir(join(root, 'configs')); await mkdir(join(root, 'fixture', prefix, 'bin'), { recursive: true });
  await writeFile(join(root, 'fixture', prefix, 'bin/node'), '#!/bin/sh\nprintf "v24.22.1\\n"\n', { mode: 0o700 });
  await writeFile(join(root, 'fixture', prefix, 'LICENSE'), 'Node test fixture license');
  execFileSync('/usr/bin/tar', ['-czf', 'release.tar.gz', prefix], { cwd: join(root, 'fixture') });
  const bytes = await readFile(join(root, 'fixture/release.tar.gz'));
  const lock = { schemaVersion: 1, version: '24.22.1', checksums: 'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt', assets: Object.fromEntries(['darwin-arm64', 'darwin-x64'].map(platform => [platform, {
    url: `https://nodejs.org/dist/v24.22.1/node-v24.22.1-${platform}.tar.gz`, sha256: createHash('sha256').update(bytes).digest('hex'),
  }])) };
  const save = () => writeFile(join(root, 'configs/rea-node.lock.json'), JSON.stringify(lock)); await save();
  const download = vi.fn(async () => new Response(bytes)); vi.stubGlobal('fetch', download);
  const packageRoot = join(root, '.pentest/toolchains/rea/node_modules/rea-agents'); await mkdir(join(packageRoot, 'dist'), { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'rea-agents', version: '6.8.0' }));
  await writeFile(join(packageRoot, 'dist/mcp-catalog-full.json'), '{}');
  return { root, lock, save, download, packageRoot };
}
it('installs the pinned supported runtime, retains its license and rejects a tampered executable', async () => {
  const f = await fixture(); const node = await installReaNode(f.root, new AbortController().signal);
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(await readFile(join(node, '../../LICENSE'), 'utf8')).toContain('fixture license');
  expect(await installRea(f.root, new AbortController().signal)).toEqual({ node, packageRoot: f.packageRoot });
  expect(f.download).toHaveBeenCalledTimes(1);
  await writeFile(node, 'tampered');
  await expect(installReaNode(f.root, new AbortController().signal)).rejects.toThrow('integrity check');
});
it('rejects mismatched checksums and non-official Node release sources', async () => {
  const f = await fixture();
  for (const asset of Object.values(f.lock.assets)) asset.sha256 = '0'.repeat(64); await f.save();
  await expect(installReaNode(f.root, new AbortController().signal)).rejects.toThrow('pinned SHA-256');
  f.download.mockClear();
  for (const asset of Object.values(f.lock.assets)) asset.url = 'https://example.test/runtime.tar.gz'; await f.save();
  await expect(installReaNode(f.root, new AbortController().signal)).rejects.toThrow('official Node release URL');
  expect(f.download).not.toHaveBeenCalled();
});
it('installs from the owner action and preserves selected analysis roots and engine settings', async () => {
  const f = await fixture(), session = id<'SessionId'>(), roots = [join(f.root, 'inputs'), join(f.root, 'selected.dmg')];
  await mkdir(roots[0]!); await writeFile(roots[1]!, 'selected file');
  const runtime = await PentestRuntime.open({ engagement: engagement(), policy: policyConfig, root: join(f.root, 'engagements'), keychainHelper: '/unused', distributionRoot: f.root }, testJudge);
  try {
    await runtime.updatePlugins(PluginConfigSchema.parse({ rea: { node: '/missing/node', packageRoot: f.packageRoot, roots, ghidra: '/owner/ghidra', javaHome: '/owner/jdk', timeoutMs: 60000 } }), session);
    await runtime.installRea(session, new AbortController().signal);
    const saved = JSON.parse(await readFile(join(runtime.root, 'plugins.json'), 'utf8'));
    expect(saved.rea).toMatchObject({ roots, ghidra: '/owner/ghidra', javaHome: '/owner/jdk', timeoutMs: 60000 });
    expect(saved.rea.node).toContain('rea-node/24.22.1');
    expect((await runtime.toolSetup()).entries.find(entry => entry.id === 'REA')?.status).toBe('configured');
  } finally { await runtime.close(); }
});
