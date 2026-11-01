/** Fail closed on scanner errors, credential files, and secrets in staged or outgoing commits. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(readFileSync(join(root, 'configs/gitleaks.lock.json'), 'utf8')).version;
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect Git input; secret check refused to continue.');
  return result.stdout;
}
/** Paths that must never be committed, even if a secret format is unrecognized. */
export function privatePath(path) {
  return /(^|\/)(?:\.pentest|\.dsh|\.security-tools|artifacts|\.wrangler)(\/|$)/.test(path)
    || /(^|\/)(?:\.credentials(?:\.[^/]*)?|\.dev\.vars(?:\.[^/]*)?|\.env(?:\.[^/]*)?)$/.test(path) && !/(?:\.example|\.sample|\.template)$/.test(path)
    || /\.(?:pem|key|p12|pfx)$/i.test(path);
}
/** Resolve the pinned scanner and prove its current configuration detects a synthetic secret. */
export function scanner() {
  const binary = process.env.GITLEAKS_BIN || (existsSync(join(root, '.security-tools/gitleaks')) ? join(root, '.security-tools/gitleaks') : 'gitleaks');
  const found = spawnSync(binary, ['version'], { encoding: 'utf8' });
  if (found.error || found.status !== 0 || found.stdout.trim().replace(/^v/, '') !== version) {
    throw new Error(`Gitleaks ${version} is required. Run node scripts/security/install.mjs; commits and pushes remain blocked.`);
  }
  const common = ['--config', join(root, '.gitleaks.toml'), '--redact=100', '--no-banner', '--log-level', 'error', '--ignore-gitleaks-allow'];
  const canary = 'ghp_' + 'Q7m8r2B9t4N6v3K5z1P0w8L2x9C4d7F6h0J1';
  const probe = spawnSync(binary, ['stdin', ...common], { cwd: root, input: `GITHUB_TOKEN=${canary}\n`, encoding: 'utf8' });
  if (probe.error || probe.signal || probe.status !== 1) throw new Error('Scanner self-test failed: synthetic secret was not detected.');
  return args => {
    const result = spawnSync(binary, [...args, ...common], { cwd: root, stdio: 'inherit' });
    if (result.error || result.signal || result.status !== 0) throw new Error('Secret scan failed. Inspect locally with --redact=100; do not bypass the check.');
  };
}
function checkPaths(paths) {
  const blocked = paths.filter(privatePath);
  if (blocked.length) throw new Error(`Private runtime or credential files must not be published:\n${blocked.join('\n')}`);
}
/** Scan staged changes, one history range, or every commit reachable from HEAD. */
export function scan(mode, range) {
  const run = scanner();
  if (mode === 'self-test') return console.log('Synthetic secret blocked by the pinned scanner.');
  if (mode === 'staged') {
    checkPaths(git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean));
    run(['git', '--staged']);
  } else if (mode === 'history' || mode === 'range') {
    const ref = range || 'HEAD';
    if (ref.startsWith('-') || !/^[A-Za-z0-9_./^~:-]+$/.test(ref)) throw new Error('Invalid scan revision');
    const tip = ref.includes('..') ? ref.split('..').at(-1) : ref;
    checkPaths(git(['ls-tree', '-r', '--name-only', '-z', tip]).split('\0').filter(Boolean));
    run(['git', `--log-opts=${ref}`]);
  } else throw new Error('Use staged, history, range <revision>, or self-test');
  console.log('Secret check passed.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === 'pre-push') {
      const updates = readFileSync(0, 'utf8').trim();
      if (!updates) throw new Error('Missing pre-push ref updates');
      for (const line of updates.split('\n')) {
        const [, local, , remote] = line.split(/\s+/);
        if (/^0+$/.test(local)) continue;
        if (!/^[a-f0-9]{40,64}$/.test(local) || !/^[a-f0-9]{40,64}$/.test(remote)) throw new Error('Invalid pre-push ref update');
        scan('range', /^0+$/.test(remote) ? local : `${remote}..${local}`);
      }
    } else scan(process.argv[2] || 'staged', process.argv[3]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
