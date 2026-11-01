import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
const yaml = require('yaml');
const sourceKey = 'fixture-spark-key', destinationKey = 'fixture-openai-key';
const provider = { displayName: 'Sparky', apiKeyEnv: 'SPARK_KEY', api: 'openai-completions',
  baseURL: 'http://127.0.0.1:9999/v1', models: [{ id: 'fixture-model', contextWindow: 128000 }] };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'djupleita-provider-import-'));
  const source = join(directory, 'source'), destination = join(directory, 'destination');
  const sourcePatch = join(source, 'profiles/desktop/cordis.patch.yml');
  const destinationPatch = join(destination, 'profiles/desktop/cordis.patch.yml');
  for (const path of [sourcePatch, destinationPatch]) await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(sourcePatch, yaml.stringify([{ id: 'llm-pi-ai', config: { providers: { sparky: provider } } }]), { mode: 0o600 });
  await writeFile(join(source, '.credentials.yaml'), yaml.stringify({ version: 1, refs: { SPARK_KEY: sourceKey, UNRELATED_KEY: 'unrelated' },
    records: { 'client-connection/browser-session': { kind: 'grant', payload: { token: 'source-browser-token' } } } }), { mode: 0o600 });
  await writeFile(destinationPatch, '# Keep my provider\n' + yaml.stringify([{ id: 'llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'OPENAI_KEY' } } } }]) +
    '- id: custom-expression\n  disabled: !!js process.platform === "linux"\n', { mode: 0o600 });
  const destinationCredentials = join(destination, '.credentials.yaml');
  await writeFile(destinationCredentials, yaml.stringify({ version: 1, refs: { OPENAI_KEY: destinationKey },
    records: { 'client-connection/browser-session': { kind: 'grant', payload: { token: 'destination-browser-token' } } } }), { mode: 0o600 });
  const run = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { importProvider } from './scripts/provider-import.mjs'; try { console.log(JSON.stringify(await importProvider(JSON.parse(process.argv[1])))); } catch (error) { console.log(JSON.stringify({error:error.message})); }",
    JSON.stringify({ sourceHome: source, destinationHome: destination, provider: 'sparky' })], { cwd: resolve('.'), encoding: 'utf8' }));
  return { directory, source, destination, sourcePatch, destinationPatch, destinationCredentials, run,
    async close() { await rm(directory, { recursive: true, force: true }); } };
}

it('recovers only the named provider and key, preserves existing secrets and survives repeated launch preparation', async () => {
  const f = await fixture();
  try {
    const beforeSource = await readFile(join(f.source, '.credentials.yaml'), 'utf8');
    const result = f.run();
    expect(result).toMatchObject({ imported: true, provider: 'sparky', profiles: ['desktop', 'pentest'] });
    const credentials = yaml.parse(await readFile(f.destinationCredentials, 'utf8'));
    expect(credentials.refs).toEqual({ OPENAI_KEY: destinationKey, SPARK_KEY: sourceKey });
    expect(credentials.records['client-connection/browser-session'].payload.token).toBe('destination-browser-token');
    expect(await readFile(join(f.source, '.credentials.yaml'), 'utf8')).toBe(beforeSource);
    const readPatch = async (name: string) => yaml.parseDocument(await readFile(join(f.destination, 'profiles', name, 'cordis.patch.yml'), 'utf8'),
      { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }).toJS();
    for (const name of ['desktop', 'pentest']) expect((await readPatch(name)).find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers.sparky).toEqual(provider);
    expect(await readFile(f.destinationPatch, 'utf8')).toContain('# Keep my provider');
    expect(await readFile(f.destinationPatch, 'utf8')).toContain('!!js');
    expect((await stat(f.destinationCredentials)).mode & 0o777).toBe(0o600);
    expect((await stat(result.backup)).mode & 0o777).toBe(0o700);
    for (const file of await readdir(result.backup)) expect((await stat(join(result.backup, file))).mode & 0o777).toBe(0o600);
    const saved = await readFile(f.destinationCredentials, 'utf8');
    const patch = await readFile(f.destinationPatch, 'utf8');
    expect(f.run()).toMatchObject({ imported: false });
    expect(await readFile(f.destinationPatch, 'utf8')).toBe(patch);
    for (let restart = 0; restart < 2; restart++) execFileSync(process.execPath, ['--input-type=module', '-e',
      "import { prepareProfile } from './scripts/profile.mjs'; await prepareProfile(process.argv[1]);", join(f.destination, 'profiles/desktop')],
    { cwd: resolve('.'), env: { ...process.env, DSH_PENTEST_ENGAGEMENT: join(f.directory, 'engagement.json') } });
    expect(await readFile(f.destinationCredentials, 'utf8')).toBe(saved);
    expect((await readPatch('desktop')).find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers.sparky).toEqual(provider);
  } finally { await f.close(); }
});

it.each(['provider', 'key'])('refuses a conflicting destination %s before changing any files', async conflict => {
  const f = await fixture();
  try {
    if (conflict === 'provider') await writeFile(f.destinationPatch, yaml.stringify([{ id: 'llm-pi-ai', config: { providers: { sparky: { ...provider, baseURL: 'https://other.test/v1' } } } }]));
    else await writeFile(f.destinationCredentials, yaml.stringify({ version: 1, refs: { SPARK_KEY: 'newer-key' } }));
    const before = await Promise.all([readFile(f.destinationPatch, 'utf8'), readFile(f.destinationCredentials, 'utf8')]);
    expect(f.run().error).toMatch(/different destination/);
    expect(await Promise.all([readFile(f.destinationPatch, 'utf8'), readFile(f.destinationCredentials, 'utf8')])).toEqual(before);
  } finally { await f.close(); }
});

it('reports malformed credentials without printing secrets or changing the destination', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.destinationCredentials, 'utf8');
    await writeFile(join(f.source, '.credentials.yaml'), 'version: [DO-NOT-PRINT-THIS\n');
    const result = f.run();
    expect(result.error).toContain('Invalid credential document');
    expect(result.error).not.toContain('DO-NOT-PRINT-THIS');
    expect(await readFile(f.destinationCredentials, 'utf8')).toBe(before);
  } finally { await f.close(); }
});
