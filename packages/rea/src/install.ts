/** Project-local REA setup. Official Node archive; pinned npm package; no client registration. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const execute = promisify(execFile);
export const REA_VERSION = '6.8.0';
export function supportedReaNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return major === 22 && (minor > 23 || minor === 23 && patch >= 4)
    || major === 24 && (minor > 22 || minor === 22 && patch >= 1)
    || major > 26 || major === 26 && minor >= 12 && (minor > 12 || patch >= 1);
}
export async function checkReaNode(node: string, signal: AbortSignal): Promise<string> {
  const { stdout } = await execute(node, ['--version'], { signal, timeout: 10000, maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '' } });
  const version = stdout.trim();
  if (!supportedReaNode(version)) throw new Error(`REA ${REA_VERSION} requires Node ^22.23.4, ^24.22.1 or >=26.12.1; selected ${version}. Use Install REA or omit --rea-node to install the managed runtime.`);
  return version;
}
const LockSchema = z.object({ schemaVersion: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), checksums: z.url(),
  assets: z.record(z.enum(['darwin-arm64', 'darwin-x64']), z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export async function installReaNode(root: string, signal: AbortSignal): Promise<string> {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) throw new Error('Managed REA runtime supports macOS arm64 and x64.');
  const lock = LockSchema.parse(JSON.parse(await readFile(join(root, 'configs/rea-node.lock.json'), 'utf8')));
  if (!supportedReaNode(lock.version)) throw new Error('Pinned REA Node version is unsupported');
  const platform = `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64', asset = lock.assets[platform];
  const prefix = `node-v${lock.version}-${platform}`;
  if (asset.url !== `https://nodejs.org/dist/v${lock.version}/${prefix}.tar.gz`) throw new Error('Invalid official Node release URL');
  const directory = join(root, '.pentest/toolchains/rea-node', lock.version, platform), node = join(directory, 'bin/node');
  const metadata = join(directory, 'installation.json');
  try {
    const saved = z.object({ archiveSha256: z.string(), binarySha256: z.string() }).parse(JSON.parse(await readFile(metadata, 'utf8')));
    if (saved.archiveSha256 !== asset.sha256 || hash(await readFile(node)) !== saved.binarySha256) throw new Error('Installed REA Node failed its integrity check. Remove its managed version directory and run setup again.');
    await checkReaNode(node, signal); return node;
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(directory), '.install-'));
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
    if (!response.ok || !response.body) throw new Error(`Node download failed (${response.status})`);
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > 128 * 1024 * 1024) throw new Error('Node archive exceeds installation limit'); parts.push(next.value); }
    } finally { await reader.cancel(); }
    const archive = Buffer.concat(parts);
    if (hash(archive) !== asset.sha256) throw new Error('Downloaded Node archive does not match the pinned SHA-256');
    const path = join(stage, 'release.tar.gz'); await writeFile(path, archive, { mode: 0o600 });
    // The complete checksum-authenticated official distribution includes its npm CLI and notices.
    await execute('/usr/bin/tar', ['-xzf', path, '-C', stage], { signal, timeout: 120000, maxBuffer: 65536 });
    const extracted = join(stage, prefix), binary = join(extracted, 'bin/node');
    await chmod(binary, 0o700); await checkReaNode(binary, signal);
    await writeFile(join(extracted, 'installation.json'), JSON.stringify({ version: lock.version, source: asset.url,
      archiveSha256: asset.sha256, binarySha256: hash(await readFile(binary)) }), { mode: 0o600 });
    signal.throwIfAborted(); await rename(extracted, directory); return node;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
export async function installRea(root: string, signal: AbortSignal, selectedNode?: string): Promise<{ node: string; packageRoot: string }> {
  const node = selectedNode ? await realpath(selectedNode) : await installReaNode(root, signal);
  await checkReaNode(node, signal);
  const prefix = join(root, '.pentest/toolchains/rea'), packageRoot = join(prefix, 'node_modules/rea-agents');
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name: string; version: string };
    await readFile(join(packageRoot, 'dist/mcp-catalog-full.json'));
    if (manifest.name === 'rea-agents' && manifest.version === REA_VERSION) return { node, packageRoot };
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  // npm belongs to the selected official runtime when managed, or the explicit owner's runtime.
  const npm = join(dirname(node), '../lib/node_modules/npm/bin/npm-cli.js');
  await mkdir(prefix, { recursive: true, mode: 0o700 });
  const home = await mkdtemp(join(prefix, '.npm-'));
  try {
    await execute(node, [npm, 'install', '--prefix', prefix, `rea-agents@${REA_VERSION}`, '--registry=https://registry.npmjs.org',
      '--ignore-scripts', '--no-audit', '--no-fund', '--engine-strict'], { signal, timeout: 600000, maxBuffer: 2 * 1024 * 1024,
      cwd: prefix, env: { PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: home, TMPDIR: home,
        npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null' } });
    const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name: string; version: string };
    if (manifest.name !== 'rea-agents' || manifest.version !== REA_VERSION) throw new Error('Unexpected installed REA package');
    return { node, packageRoot };
  } finally { await rm(home, { recursive: true, force: true }); }
}
