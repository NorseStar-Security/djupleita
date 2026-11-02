/** Project-local, checksum-verified ProjectDiscovery release installation. No target traffic. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ReconToolSchema } from './tools.ts';
import type { ReconTool } from './tools.ts';

const execute = promisify(execFile);
const AssetSchema = z.object({ url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const LockSchema = z.object({ schemaVersion: z.literal(1), tools: z.record(ReconToolSchema,
  z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), checksums: z.string().url(),
    assets: z.record(z.enum(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']), AssetSchema) })) });
type Binary = { path: string; sha256: string };
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const MAX_ARCHIVE = 256 * 1024 * 1024;

async function download(url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
  if (!response.ok || !response.body) throw new Error(`Recon download failed (${response.status}): ${url}`);
  const parts: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > MAX_ARCHIVE) throw new Error('Recon archive exceeds the installation size limit');
      parts.push(next.value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}

/**
 * Install locked releases under the project and return executable hashes for the adapter.
 * Existing verified installations are reused. Mismatches fail before extraction or execution.
 * @param root - trusted distribution root containing configs/recon-tools.lock.json.
 * @param signal - cancellation of installation; no network or target scope is changed.
 * @returns exact executable paths and SHA-256 values, including all five supported tools.
 */
export async function installReconTools(root: string, signal: AbortSignal): Promise<Record<ReconTool, Binary>> {
  const lock = LockSchema.parse(JSON.parse(await readFile(join(root, 'configs/recon-tools.lock.json'), 'utf8')));
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('Managed recon releases support macOS and Linux arm64/x64.');
  const platform = `${process.platform}-${process.arch}` as 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64';
  const installed: Partial<Record<ReconTool, Binary>> = {};
  for (const tool of ReconToolSchema.options) {
    signal.throwIfAborted();
    const release = lock.tools[tool], asset = release.assets[platform];
    if (!asset) throw new Error(`No pinned ${tool} release for ${platform}`);
    const expected = `https://github.com/projectdiscovery/${tool}/releases/download/v${release.version}/${tool}_${release.version}_${process.platform === 'darwin' ? 'macOS' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}.zip`;
    if (asset.url !== expected) throw new Error(`Invalid official release URL for ${tool}`);
    const directory = join(root, '.pentest/toolchains/projectdiscovery', tool, release.version, platform);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const binary = join(directory, tool), metadata = join(directory, 'installation.json');
    try {
      const saved = z.object({ archiveSha256: z.string(), binarySha256: z.string() }).parse(JSON.parse(await readFile(metadata, 'utf8')));
      if (saved.archiveSha256 !== asset.sha256 || sha256(await readFile(binary)) !== saved.binarySha256) throw new Error(`Installed ${tool} failed its integrity check. Remove its managed version directory and run setup again.`);
      await chmod(binary, 0o700);
      installed[tool] = { path: binary, sha256: saved.binarySha256 }; continue;
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const stage = await mkdtemp(join(directory, '.install-'));
    try {
      const archive = await download(asset.url, signal);
      if (sha256(archive) !== asset.sha256) throw new Error(`Downloaded ${tool} archive does not match the pinned SHA-256`);
      const zip = join(stage, 'release.zip'); await writeFile(zip, archive, { mode: 0o600 });
      // Read named entries only; archive paths cannot choose filesystem destinations.
      const { stdout: bytes } = await execute('/usr/bin/unzip', ['-p', zip, tool], { encoding: 'buffer', maxBuffer: MAX_ARCHIVE, signal });
      if (!bytes.length) throw new Error(`${tool} archive contains no executable`);
      const { stdout: listing } = await execute('/usr/bin/unzip', ['-Z1', zip], { maxBuffer: 65536, signal });
      const license = listing.split('\n').find(entry => /^LICENSE(?:\.(?:md|txt))?$/i.test(entry));
      if (!license) throw new Error(`${tool} archive is missing its license notice`);
      const { stdout: notice } = await execute('/usr/bin/unzip', ['-p', zip, license], { encoding: 'buffer', maxBuffer: 1024 * 1024, signal });
      await writeFile(join(stage, tool), bytes, { mode: 0o700 });
      const hash = sha256(bytes);
      await writeFile(join(stage, 'installation.json'), JSON.stringify({ version: release.version, source: asset.url,
        archiveSha256: asset.sha256, binarySha256: hash }), { mode: 0o600 });
      signal.throwIfAborted();
      await writeFile(join(directory, 'LICENSE.txt'), notice, { mode: 0o600 });
      await rename(join(stage, tool), binary); await rename(join(stage, 'installation.json'), metadata);
      installed[tool] = { path: binary, sha256: hash };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
  return z.record(ReconToolSchema, z.object({ path: z.string(), sha256: z.string() })).parse(installed);
}
