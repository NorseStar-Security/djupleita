/** Install official, pinned ffuf releases without global writes or target traffic. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const execute = promisify(execFile);
const LockSchema = z.object({ schemaVersion: z.literal(1), version: z.string().regex(/^\d+\.\d+\.\d+$/), checksums: z.url(),
  assets: z.partialRecord(z.enum(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']), z.object({ url: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })) });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE = 64 * 1024 * 1024;
export async function installFfuf(root: string, signal: AbortSignal): Promise<{ path: string; sha256: string }> {
  const lock = LockSchema.parse(JSON.parse(await readFile(join(root, 'configs/ffuf.lock.json'), 'utf8')));
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('Managed ffuf releases support macOS and Linux arm64/x64.');
  signal.throwIfAborted();
  const platform = `${process.platform}-${process.arch}` as 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64', asset = lock.assets[platform];
  if (!asset) throw new Error(`No pinned ffuf release for ${platform}`);
  const expected = `https://github.com/ffuf/ffuf/releases/download/v${lock.version}/ffuf_${lock.version}_${process.platform === 'darwin' ? 'macOS' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tar.gz`;
  if (asset.url !== expected) throw new Error('Invalid official ffuf release URL');
  const directory = join(root, '.pentest/toolchains/ffuf', lock.version, platform);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const binary = join(directory, 'ffuf'), metadata = join(directory, 'installation.json');
  try {
    const saved = z.object({ archiveSha256: z.string(), binarySha256: z.string() }).parse(JSON.parse(await readFile(metadata, 'utf8')));
    if (saved.archiveSha256 !== asset.sha256 || hash(await readFile(binary)) !== saved.binarySha256) throw new Error('Installed ffuf failed its integrity check. Remove its managed version directory and run setup again.');
    await chmod(binary, 0o700); return { path: binary, sha256: saved.binarySha256 };
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const stage = await mkdtemp(join(directory, '.install-'));
  try {
    const response = await fetch(asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
    if (!response.ok || !response.body) throw new Error(`ffuf download failed (${response.status})`);
    const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length;
        if (size > MAX_ARCHIVE) throw new Error('ffuf archive exceeds the installation size limit'); parts.push(next.value); }
    } finally { await reader.cancel(); }
    const archive = Buffer.concat(parts);
    if (hash(archive) !== asset.sha256) throw new Error('Downloaded ffuf archive does not match the pinned SHA-256');
    const path = join(stage, 'release.tar.gz'); await writeFile(path, archive, { mode: 0o600 });
    // Extract only named entries to fixed destinations, never archive-chosen paths.
    const { stdout: bytes } = await execute('/usr/bin/tar', ['-xOf', path, 'ffuf'], { encoding: 'buffer', maxBuffer: MAX_ARCHIVE, signal });
    const { stdout: license } = await execute('/usr/bin/tar', ['-xOf', path, 'LICENSE'], { encoding: 'buffer', maxBuffer: 1024 * 1024, signal });
    if (!bytes.length || !license.length) throw new Error('ffuf archive is missing its executable or license');
    const sha256 = hash(bytes);
    await writeFile(join(stage, 'ffuf'), bytes, { mode: 0o700 });
    await writeFile(join(stage, 'installation.json'), JSON.stringify({ version: lock.version, source: asset.url,
      archiveSha256: asset.sha256, binarySha256: sha256 }), { mode: 0o600 });
    signal.throwIfAborted();
    await writeFile(join(directory, 'LICENSE.txt'), license, { mode: 0o600 });
    await rename(join(stage, 'ffuf'), binary); await rename(join(stage, 'installation.json'), metadata);
    return { path: binary, sha256 };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
