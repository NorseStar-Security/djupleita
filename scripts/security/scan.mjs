/** Fail closed on scanner errors, credential files, and secrets in staged or outgoing commits. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const version = JSON.parse(readFileSync(join(root, 'configs/gitleaks.lock.json'), 'utf8')).version;
function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, { cwd: root, encoding, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect Git input; secret check refused to continue.');
  return result.stdout;
}
/** Paths that must never be committed, even if a secret format is unrecognized. */
export function privatePath(path) {
  return /(^|\/)(?:\.pentest|\.dsh|\.security-tools|artifacts|\.wrangler)(\/|$)/.test(path)
    || /(^|\/)(?:\.credentials(?:\.[^/]*)?|\.dev\.vars(?:\.[^/]*)?|\.env(?:\.[^/]*)?)$/.test(path) && !/(?:\.example|\.sample|\.template)$/.test(path)
    || /\.(?:pem|key|p12|pfx)$/i.test(path);
}
const imagePath = /\.(?:png|jpe?g|tiff?|webp|bmp|gif)$/i;
function references() {
  try {
    return JSON.parse(process.env.DJUPLEITA_CONFIDENTIAL_REFERENCES || readFileSync(join(root, '.security-tools/confidential-references.json'), 'utf8'));
  } catch {
    throw new Error('Configure the private reference list in .security-tools/confidential-references.json or DJUPLEITA_CONFIDENTIAL_REFERENCES; publishing remains blocked.');
  }
}
function referenceExpression(terms) {
  return terms.map(term => {
    const normalized = term.replace(/[\s._-]/g, '');
    const expression = [...normalized].join('[\\s._-]*');
    return normalized.length <= 3 ? `\\b${expression}\\b` : expression;
  }).join('|');
}
/** OCR stays local and its output is never printed or stored. Missing/broken OCR fails closed. */
export function imageText(bytes) {
  const result = spawnSync(process.env.TESSERACT_BIN || 'tesseract', ['stdin', 'stdout', '-l', 'eng', '--psm', '11'], {
    input: bytes, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('Screenshot scan failed. Install Tesseract with English data; image changes remain blocked.');
  }
  return result.stdout;
}
/** Build a private, ephemeral scanner config. Never put protected terms or derived regexes in Git. */
export function scanner(options = {}) {
  const terms = options.references ?? references();
  if (!Array.isArray(terms) || terms.length < 1 || terms.length > 20 || terms.some(term => typeof term !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,127}$/.test(term) || term.replace(/[\s._-]/g, '').length < 2)) {
    throw new Error('The private reference list must contain 1–20 nonempty customer names or domains.');
  }
  const pattern = referenceExpression(terms);
  const binary = process.env.GITLEAKS_BIN || (existsSync(join(root, '.security-tools/gitleaks')) ? join(root, '.security-tools/gitleaks') : 'gitleaks');
  const found = spawnSync(binary, ['version'], { encoding: 'utf8' });
  if (found.error || found.status !== 0 || found.stdout.trim().replace(/^v/, '') !== version) {
    throw new Error(`Gitleaks ${version} is required. Run node scripts/security/install.mjs; commits and pushes remain blocked.`);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'djupleita-scan-'));
  const close = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const config = join(scratch, 'private-gitleaks.toml');
    writeFileSync(config, readFileSync(join(root, '.gitleaks.toml'), 'utf8') + `\n[[rules]]\nid = "confidential-engagement-reference"\ndescription = "Confidential customer or assessment reference"\nregex = '''(?i)${pattern}'''\n`, { mode: 0o600 });
    const common = ['--config', config, '--redact=100', '--no-banner', '--log-level', 'error', '--ignore-gitleaks-allow'];
    const canaries = ['GITHUB_TOKEN=ghp_' + 'Q7m8r2B9t4N6v3K5z1P0w8L2x9C4d7F6h0J1', ...terms];
    for (const canary of canaries) {
      const probe = spawnSync(binary, ['stdin', ...common], { cwd: root, input: canary + '\n', encoding: 'utf8' });
      if (probe.error || probe.signal || probe.status !== 1) throw new Error('Scanner self-test failed: a synthetic credential or configured private reference was not detected.');
    }
    const run = (args, input) => {
      const result = spawnSync(binary, [...args, ...common], {
        cwd: root, ...(input === undefined ? { stdio: 'inherit' } : { input, encoding: 'utf8' }),
      });
      if (result.error || result.signal || result.status !== 0) throw new Error('Secret scan failed. Inspect locally with --redact=100; do not bypass the check.');
    };
    run.close = close;
    run.config = config;
    run.referencePattern = new RegExp(pattern, 'i');
    const longTerms = terms.filter(term => term.replace(/[\s._-]/g, '').length > 3);
    run.metadataPattern = longTerms.length ? new RegExp(referenceExpression(longTerms), 'i') : undefined;
    return run;
  } catch (error) { close(); throw error; }
}
function checkReferencePaths(paths, pattern) {
  if (paths.some(path => pattern.test(path))) throw new Error('A filename contains a confidential assessment reference; publishing refused.');
}
function checkPaths(paths, pattern) {
  checkReferencePaths(paths, pattern);
  const blocked = paths.filter(privatePath);
  if (blocked.length) throw new Error(`Private runtime or credential files must not be published:\n${blocked.join('\n')}`);
}
/** Inspect each staged or historical image blob once, including images deleted by a later commit. */
function checkImages(mode, ref, run) {
  const entries = mode === 'staged'
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACM', '--no-renames', '-z']).split('\0').filter(Boolean).map(path => ({ path, object: `:${path}` }))
    : git(['rev-list', '--objects', ref]).trim().split('\n').map(line => {
      const space = line.indexOf(' ');
      return { object: space === -1 ? line : line.slice(0, space), path: space === -1 ? '' : line.slice(space + 1) };
    });
  checkReferencePaths(entries.map(entry => entry.path), run.referencePattern);
  const scanned = new Set();
  for (const { path, object } of entries) {
    if (!imagePath.test(path) || scanned.has(object)) continue;
    scanned.add(object);
    const bytes = git(['show', object], null);
    // Compressed pixels can coincidentally spell a short initialism. Inspect full
    // names in raw metadata; check short names only in recognized image text.
    if (run.metadataPattern?.test(bytes.toString('latin1'))) throw new Error('An image contains confidential metadata; publishing refused.');
    const text = imageText(bytes);
    if (run.referencePattern.test(text)) throw new Error('A screenshot contains a confidential assessment reference; publishing refused.');
    run(['stdin'], text);
  }
  if (scanned.size) console.log(`Checked ${scanned.size} image blobs with local OCR.`);
}
/** Scan staged changes, one history range, or every commit reachable from HEAD. */
export function scan(mode, range) {
  const run = scanner();
  try {
    if (mode === 'self-test') return console.log('Credentials and privately configured references blocked by the pinned scanner.');
    if (mode === 'staged') {
      checkPaths(git(['ls-files', '--cached', '-z']).split('\0').filter(Boolean), run.referencePattern);
      run(['git', '--staged']);
      checkImages(mode, undefined, run);
    } else if (mode === 'history' || mode === 'range') {
      const ref = range || 'HEAD';
      if (ref.startsWith('-') || !/^[A-Za-z0-9_./^~:-]+$/.test(ref)) throw new Error('Invalid scan revision');
      const tip = ref.includes('..') ? ref.split('..').at(-1) : ref;
      checkPaths(git(['ls-tree', '-r', '--name-only', '-z', tip]).split('\0').filter(Boolean), run.referencePattern);
      run(['git', `--log-opts=${ref}`]);
      checkImages(mode, ref, run);
    } else throw new Error('Use staged, history, range <revision>, or self-test');
    console.log('Secret check passed.');
  } finally { run.close(); }
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
