/** Install the checksum-pinned scanner without installing project dependencies. */
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const lock = JSON.parse(await readFile(join(root, 'configs/gitleaks.lock.json'), 'utf8'));
const archive = lock.archives[`${process.platform}-${process.arch}`];
if (!archive) throw new Error('Use an officially distributed Gitleaks 8.30.0 binary on this platform.');
const temporary = await mkdtemp(join(tmpdir(), 'djupleita-scanner-'));
try {
  const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${lock.version}/${archive.name}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Scanner download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== archive.sha256) throw new Error('Scanner checksum mismatch');
  await writeFile(join(temporary, 'archive.tar.gz'), bytes);
  const unpack = spawnSync('tar', ['-xzf', join(temporary, 'archive.tar.gz'), '-C', temporary, 'gitleaks'], { stdio: 'inherit' });
  if (unpack.error || unpack.status !== 0) throw new Error('Cannot unpack scanner');
  await mkdir(join(root, '.security-tools'), { recursive: true });
  await writeFile(join(root, '.security-tools/gitleaks'), await readFile(join(temporary, 'gitleaks')));
  await chmod(join(root, '.security-tools/gitleaks'), 0o755);
  console.log(`Installed checksum-verified Gitleaks ${lock.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
