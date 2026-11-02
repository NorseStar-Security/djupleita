import { afterEach, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFfuf } from '../packages/fuzz/src/index.ts';
import { PentestRuntime } from '../packages/dsh-plugin/src/runtime.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';

const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-ffuf-')); directories.push(root);
  await mkdir(join(root, 'configs')); await mkdir(join(root, 'fixture'));
  await writeFile(join(root, 'fixture/ffuf'), '#!/bin/sh\n# fixture, never executed\nexit 0\n');
  await writeFile(join(root, 'fixture/LICENSE'), 'Local test fixture license');
  execFileSync('/usr/bin/tar', ['-czf', 'release.tar.gz', 'ffuf', 'LICENSE'], { cwd: join(root, 'fixture') });
  const archive = await readFile(join(root, 'fixture/release.tar.gz'));
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const lock = { schemaVersion: 1, version: '2.3.0', checksums: 'https://github.com/ffuf/ffuf/releases/download/v2.3.0/ffuf_2.3.0_checksums.txt',
    assets: Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(platform => [platform, {
      url: `https://github.com/ffuf/ffuf/releases/download/v2.3.0/ffuf_2.3.0_${platform.startsWith('darwin') ? 'macOS' : 'linux'}_${platform.endsWith('arm64') ? 'arm64' : 'amd64'}.tar.gz`, sha256,
    }])) };
  const save = () => writeFile(join(root, 'configs/ffuf.lock.json'), JSON.stringify(lock)); await save();
  const download = vi.fn(async () => new Response(archive)); vi.stubGlobal('fetch', download);
  return { root, lock, save, download };
}

it('installs verified ffuf with a license, reuses it, and rejects local tampering', async () => {
  const f = await fixture(), binary = await installFfuf(f.root, AbortSignal.timeout(5000));
  expect(await readFile(join(binary.path, '../LICENSE.txt'), 'utf8')).toContain('fixture license');
  expect(await installFfuf(f.root, AbortSignal.timeout(5000))).toEqual(binary); expect(f.download).toHaveBeenCalledTimes(1);
  await writeFile(binary.path, 'tampered');
  await expect(installFfuf(f.root, AbortSignal.timeout(5000))).rejects.toThrow('integrity check');
});

it('rejects altered archives and unrecognized release sources before extraction', async () => {
  const f = await fixture();
  for (const asset of Object.values(f.lock.assets)) asset.sha256 = '0'.repeat(64);
  await f.save(); await expect(installFfuf(f.root, AbortSignal.timeout(5000))).rejects.toThrow('pinned SHA-256');
  f.download.mockClear(); for (const asset of Object.values(f.lock.assets)) asset.url = 'https://outside.invalid/ffuf.tar.gz';
  await f.save(); await expect(installFfuf(f.root, AbortSignal.timeout(5000))).rejects.toThrow('official ffuf release URL');
  expect(f.download).not.toHaveBeenCalled();
});

it('installs and activates ffuf through the owner action, retaining it across restart and local setup import', async () => {
  const f = await fixture(), session = id<'SessionId'>();
  const config = { engagement: engagement(), policy: policyConfig, root: join(f.root, 'engagements'), keychainHelper: '/unused', distributionRoot: f.root };
  const runtime = await PentestRuntime.open(config, testJudge);
  try {
    expect((await runtime.toolSetup()).entries.find(row => row.id === 'ffuf')?.status).toBe('missing');
    await runtime.installFfuf(session, AbortSignal.timeout(5000));
    expect((await runtime.toolSetup()).entries.find(row => row.id === 'ffuf')?.status).toBe('ready');
    const local = JSON.parse(await readFile(join(f.root, '.pentest/tooling.json'), 'utf8'));
    expect(local.ffuf.binary.path).toContain('/ffuf');
    await runtime.loadLocalSetup(session);
    expect((await runtime.trajectories.read(session)).some(row => row.type === 'plugins/settings')).toBe(true);
  } finally { await runtime.close(); }
  const reopened = await PentestRuntime.open(config, testJudge);
  try { expect((await reopened.toolSetup()).entries.find(row => row.id === 'ffuf')?.status).toBe('ready'); }
  finally { await reopened.close(); }
});
