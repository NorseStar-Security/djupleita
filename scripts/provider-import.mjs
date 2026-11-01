/** Explicitly recover one named model provider from another Harness home. */
import { readFile, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { home } from './profile.mjs';
import { withFileLock, writeFileAtomic } from '../vendor/deepseek-harness/packages/util/atomic-write/lib/index.js';
import { parseCredentialsDocument } from '../vendor/deepseek-harness/packages/credentials/credentials-local/lib/index.js';

const require = createRequire(new URL('../vendor/deepseek-harness/packages/boot/config-editor/package.json', import.meta.url));
const { parseDocument, isMap, isSeq, visit } = require('yaml');
const privateWrite = { mode: 0o600, dirMode: 0o700 };

async function readPrivate(path, fallback) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || (info.mode & 0o077)) throw new Error(`Expected an owner-only regular file: ${path}`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

function credentials(text, path) {
  // Even schema errors must never include credential values in CLI output.
  try { return parseCredentialsDocument(text, path); }
  catch { throw new Error(`Invalid credential document; left unchanged: ${path}`); }
}

function profile(text) {
  const doc = parseDocument(text, { prettyErrors: false,
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('Invalid profile patch; no provider was imported.');
  return doc;
}

function providerRows(doc) {
  return doc.contents.items.filter(row => isMap(row) && row.get('id') === 'llm-pi-ai' && !row.has('insert'));
}

function findProvider(doc, name) {
  return providerRows(doc).map(row => row.getIn(['config', 'providers', name], true)).filter(node => node !== undefined);
}

/** Missing-only import: no network requests, environment fallback, or copying of sign-in/browser grants. */
export async function importProvider({ sourceHome, destinationHome = home, provider, profiles = ['desktop', 'pentest'] }) {
  if (typeof provider !== 'string' || !provider.length) throw new Error('Specify the exact provider ID to import.');
  sourceHome = resolve(sourceHome); destinationHome = resolve(destinationHome);
  if (sourceHome === destinationHome) throw new Error('Source and destination homes must differ.');
  if (!profiles.length || profiles.some(name => !['desktop', 'pentest'].includes(name))) throw new Error('Unsupported destination profile.');
  const sourcePatch = profile(await readPrivate(join(sourceHome, 'profiles/desktop/cordis.patch.yml')));
  const matches = findProvider(sourcePatch, provider);
  if (matches.length !== 1 || !isMap(matches[0])) throw new Error('Expected exactly one static provider definition in the source desktop profile.');
  const selected = matches[0];
  visit(selected, (_key, node) => {
    if (node?.tag || node?.constructor?.name === 'Alias') throw new Error('Provider expressions, tags and aliases require manual migration.');
  });
  const ref = selected.get('apiKeyEnv');
  if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('Provider must name a static API key reference.');
  const sourceFile = join(sourceHome, '.credentials.yaml');
  const sourceKey = credentials(await readPrivate(sourceFile), sourceFile).refs.get(ref);
  if (!sourceKey) throw new Error('The named provider has no saved API key in the source home.');

  await mkdir(destinationHome, { recursive: true, mode: 0o700 });
  const directories = [...new Set(profiles)].map(name => join(destinationHome, 'profiles', name)).sort();
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  const destinationFile = join(destinationHome, '.credentials.yaml');
  // Match the credentials service and config editor's own cross-process lock names.
  const locks = [destinationFile, ...directories.map(directory => join(directory, 'package.json'))];
  const locked = index => index === locks.length ? commit() : withFileLock(locks[index], () => locked(index + 1), { waitMs: 30000 });
  return locked(0);

  async function commit() {
    const beforeCredentials = await readPrivate(destinationFile, 'version: 1\nrefs: {}\nrecords: {}\n');
    const saved = credentials(beforeCredentials, destinationFile);
    const existingKey = saved.refs.get(ref);
    if (existingKey !== undefined && existingKey !== sourceKey) throw new Error('A different destination key already exists; nothing was overwritten.');
    const edits = [];
    for (const directory of directories) {
      const path = join(directory, 'cordis.patch.yml');
      const before = await readPrivate(path, '[]\n');
      const doc = profile(before), existing = findProvider(doc, provider);
      if (existing.length) {
        if (existing.length !== 1 || !isDeepStrictEqual(existing[0].toJSON(), selected.toJSON())) {
          throw new Error('A different destination provider already exists; nothing was overwritten.');
        }
        continue;
      }
      let row = providerRows(doc).at(-1);
      if (!row) { row = doc.createNode({ id: 'llm-pi-ai', config: { providers: {} } }); doc.add(row); }
      row.setIn(['config', 'providers', provider], selected.clone());
      edits.push({ path, before, after: doc.toString({ lineWidth: 0 }), backupName: `${directory.split('/').at(-1)}.patch.yml` });
    }
    if (existingKey === undefined) {
      const doc = parseDocument(beforeCredentials, { prettyErrors: false });
      doc.set('version', 1); doc.setIn(['refs', ref], sourceKey);
      edits.unshift({ path: destinationFile, before: beforeCredentials, after: doc.toString({ lineWidth: 0 }), backupName: '.credentials.yaml' });
    }
    if (!edits.length) return { provider, imported: false, profiles: [...new Set(profiles)] };
    const backup = join(destinationHome, 'provider-import-backups', randomUUID());
    await mkdir(backup, { recursive: true, mode: 0o700 });
    // Validate every conflict before writing. Key first makes an interrupted import safe to retry.
    for (const edit of edits) await writeFileAtomic(join(backup, edit.backupName), edit.before, privateWrite);
    for (const edit of edits) await writeFileAtomic(edit.path, edit.after, privateWrite);
    return { provider, imported: true, profiles: [...new Set(profiles)], backup };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { 'from-home': { type: 'string' }, provider: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) console.log('Usage: pnpm import:provider --from-home /path/to/.dsh --provider exact-provider-id\nImports the named desktop provider and saved API key into Djupleita desktop and web profiles. Existing settings and keys are never replaced. No provider requests are sent.');
    else {
      if (!values['from-home'] || !values.provider) throw new Error('Both --from-home and --provider are required. Use --help for usage.');
      const result = await importProvider({ sourceHome: values['from-home'], provider: values.provider });
      console.log(result.imported ? `Imported ${result.provider}; restart Djupleita to load it.` : `${result.provider} is already imported; no files changed.`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
