import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LinuxSecretServiceProvider } from '../packages/identities/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('keeps secret bytes off argv, preserves multiline values and handles missing items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-secret-service-')); roots.push(root);
  const helper = join(root, 'secret-tool'), storage = join(root, 'store'), argv = join(root, 'argv');
  await writeFile(helper, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2)));
const op = process.argv[2], path = ${JSON.stringify(storage)};
if (op === 'store') { let s = ''; process.stdin.on('data', b => s += b); process.stdin.on('end', () => fs.writeFileSync(path, s)); }
else if (op === 'lookup') { try { console.log(fs.readFileSync(path, 'utf8')); } catch { process.exitCode = 1; } }
else if (op === 'clear') { fs.rmSync(path, { force: true }); }
`, { mode: 0o700 });
  const provider = new LinuxSecretServiceProvider(helper), value = 'fixture α\nwith trailing lines\n\n';
  expect(await provider.get('fixture/reference')).toBeUndefined();
  await provider.set('fixture/reference', value);
  const args = JSON.parse(await readFile(argv, 'utf8'));
  expect(args).toEqual(['store', '--label=Djupleita engagement identity', 'application', 'djupleita', 'reference', 'fixture/reference']);
  expect(await provider.get('fixture/reference')).toBe(value);
  await provider.remove('fixture/reference'); expect(await provider.get('fixture/reference')).toBeUndefined();
});
it('fails closed with actionable guidance when the Linux secure store is unavailable', async () => {
  await expect(new LinuxSecretServiceProvider('/nonexistent/secret-tool').set('fixture/reference', 'fixture value'))
    .rejects.toMatchObject({ code: 'SECRET_SERVICE_UNAVAILABLE' });
});
it.skipIf(process.platform !== 'linux' || !process.env.DSH_TEST_SECRET_SERVICE)('round-trips against an isolated Linux session keyring', async () => {
  const provider = new LinuxSecretServiceProvider(), reference = `test/${id<'FixtureId'>()}`, secret = `fixture-${id<'FixtureSecret'>()}\n\n`;
  try { await provider.set(reference, secret); expect(await provider.get(reference)).toBe(secret); }
  finally { await provider.remove(reference); }
  expect(await provider.get(reference)).toBeUndefined();
}, 35000);
