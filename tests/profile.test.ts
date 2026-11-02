import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
const yaml = require('yaml');

it('upgrades an old preset with compaction and orchestration while preserving provider settings and disabled bundles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'djupleita-profile-'));
  const prepare = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { prepareProfile } from './scripts/profile.mjs'; await prepareProfile(process.argv[1]);", directory],
  { cwd: resolve('.'), env: { ...process.env, DSH_PENTEST_ENGAGEMENT: join(directory, 'engagement.json') } });
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'existing-profile',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }));
    prepare();
    const engagementPath = join(directory, 'engagement.json');
    const freshEngagement = await readFile(engagementPath, 'utf8');
    expect(JSON.parse(freshEngagement).scope).toEqual(JSON.parse(await readFile(resolve('configs/scope.example.json'), 'utf8')));
    expect(JSON.parse(freshEngagement).scope.enabled).toBe(false);
    const path = join(directory, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    expect(manifest.dsh.profile.bundles).toContain('@djupleita/plugin-rea');
    expect(manifest.dsh.profile.bundles).toContain('@djupleita/plugin-recon');
    expect(manifest.dsh.profile.bundles).toContain('@djupleita/plugin-ffuf');
    expect(manifest.dsh.profile.bundles).toContain('@djupleita/plugin-assessment');
    expect(manifest.dsh.profile.bundles).toContain('@djupleita/plugin-validation');
    expect(manifest.dependencies['@djupleita/plugin-rea']).toBe(`link:${resolve('packages/plugin-rea')}`);
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== '@djupleita/plugin-rea');
    // Simulate a profile from before ffuf and bundle introduction tracking existed.
    delete manifest.dsh.profile.distributionBundles;
    delete manifest.dependencies['@djupleita/plugin-ffuf'];
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name: string) => name !== '@djupleita/plugin-ffuf');
    await writeFile(path, JSON.stringify(manifest));
    const patchPath = join(directory, 'cordis.patch.yml');
    const original = yaml.parseDocument(await readFile(patchPath, 'utf8'));
    original.contents.items.find((row: { get(key: string): string }) => row.get('id') === 'agent-preset-registry').get('config').set('default', 'ptc');
    for (const row of original.contents.items) {
      for (const entry of row.get('insert')?.items ?? []) {
        if (entry.get('id') === 'preset-standard') {
          const bash = entry.get('config').get('plugins').items.find((plugin: { get(key: string): string }) => plugin.get('id') === 'tool-bash');
          bash.delete('disabled'); bash.set('disabled', true);
          entry.get('config').get('plugins').items.find((plugin: { get(key: string): string }) => plugin.get('id') === 'persona').get('config').set('prefix', 'User-authored coding instructions');
        }
        if (entry.get('id') === 'preset-pentest') {
          const plugins = entry.get('config').get('plugins');
          plugins.items = plugins.items.filter((plugin: { get(key: string): string }) =>
            !['compaction', 'command-goal', 'tool-goal', 'delegation'].includes(plugin.get('id')));
        }
      }
    }
    const originalPatch = original.toString();
    const providerPatch = '\n# Saved model settings must survive startup\n- id: llm-pi-ai\n  config:\n    providers:\n      openai:\n        apiKeyEnv: FIXTURE_OPENAI_KEY\n        models: [{id: fixture-model, contextWindow: 128000}]\n- id: custom-expression\n  disabled: !!js process.platform === "linux"\n';
    await writeFile(patchPath, originalPatch + providerPatch);
    prepare();
    expect(JSON.parse(await readFile(path, 'utf8')).dsh.profile.bundles).not.toContain('@djupleita/plugin-rea');
    expect(JSON.parse(await readFile(path, 'utf8')).dsh.profile.bundles).toContain('@djupleita/plugin-ffuf');
    const patch = await readFile(patchPath, 'utf8');
    expect(patch).toContain('@dsh-pentest/dsh-plugin/core');
    expect(patch).toContain('# Saved model settings must survive startup');
    expect(patch).toContain('!!js');
    const rows = yaml.parseDocument(patch, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }).toJS();
    expect(rows.find((row: { id: string }) => row.id === 'agent-preset-registry').config.default).toBe('ptc');
    const standard = rows.flatMap((row: { insert?: unknown[] }) => row.insert ?? []).find((row: { id: string }) => row.id === 'preset-standard').config;
    expect(standard.plugins.find((plugin: { id: string }) => plugin.id === 'tool-bash').disabled).toBe(true);
    expect(standard.plugins.find((plugin: { id: string }) => plugin.id === 'persona').config.prefix).toBe('User-authored coding instructions');
    expect(rows.find((row: { id: string }) => row.id === 'llm-pi-ai').config.providers.openai)
      .toEqual({ apiKeyEnv: 'FIXTURE_OPENAI_KEY', models: [{ id: 'fixture-model', contextWindow: 128000 }] });
    const preset = rows.flatMap((row: { insert?: unknown[] }) => row.insert ?? []).find((row: { id: string }) => row.id === 'preset-pentest').config;
    const compaction = preset.plugins.find((plugin: { id: string }) => plugin.id === 'compaction');
    expect(compaction.isolate).toEqual({ compaction: true, toolResultPruner: true });
    expect(compaction.config).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '@deepseek-ai/dsh-compaction-basic', config: expect.objectContaining({ auto: true, maxOverflowRetries: 1 }) }),
      expect.objectContaining({ name: '@deepseek-ai/dsh-command-compact' }),
      expect.objectContaining({ name: '@deepseek-ai/dsh-compaction-tool-result-pruner' }),
    ]));
    expect(preset.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '@deepseek-ai/dsh-command-goal' }),
      expect.objectContaining({ name: '@deepseek-ai/dsh-tool-goal' }),
      expect.objectContaining({ id: 'delegation', config: expect.arrayContaining([
        expect.objectContaining({ name: '@deepseek-ai/dsh-tool-subagent-control' }),
        expect.objectContaining({ name: '@deepseek-ai/dsh-tool-subagent', config: expect.objectContaining({ provider: 'spawn', toolName: 'subagent' }) }),
        expect.objectContaining({ name: '@deepseek-ai/dsh-tool-subagent', config: expect.objectContaining({ provider: 'fork', toolName: 'subagent_fork' }) }),
      ]) }),
    ]));
    prepare();
    expect(await readFile(patchPath, 'utf8')).toBe(patch);
    expect(await readFile(engagementPath, 'utf8')).toBe(freshEngagement);
    const upgraded = JSON.parse(await readFile(path, 'utf8'));
    upgraded.dsh.profile.bundles = upgraded.dsh.profile.bundles.filter((name: string) => name !== '@djupleita/plugin-ffuf');
    await writeFile(path, JSON.stringify(upgraded)); prepare();
    expect(JSON.parse(await readFile(path, 'utf8')).dsh.profile.bundles).not.toContain('@djupleita/plugin-ffuf');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('saves course defaults for legacy empty boundaries once and preserves explicit scope choices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'djupleita-scope-defaults-'));
  const path = join(directory, 'engagement.json');
  const defaults = JSON.parse(await readFile(resolve('configs/scope.example.json'), 'utf8'));
  const template = JSON.parse(await readFile(resolve('configs/engagement.example.json'), 'utf8'));
  const services = { ...defaults.services, model: [{ host: 'model.example.test', schemes: ['https'], ports: [443], pathPrefixes: ['/v1'], allowPrivateAddresses: false }] };
  const legacy = { targets: [], exclusions: [], networks: [], services };
  const prepare = () => execFileSync(process.execPath, ['--input-type=module', '-e',
    "import { prepareProfile } from './scripts/profile.mjs'; await prepareProfile(process.argv[1]);", directory],
  { cwd: resolve('.'), env: { ...process.env, DSH_PENTEST_ENGAGEMENT: path } });
  try {
    const original = JSON.stringify({ ...template, scope: legacy });
    await writeFile(path, original);
    // Recover safely if a previous launch stopped after creating the backup.
    await writeFile(`${path}.pre-scope-defaults.bak`, original, { mode: 0o600 });
    prepare();
    const migrated = await readFile(path, 'utf8');
    expect(JSON.parse(migrated)).toEqual({ ...template, scope: { ...defaults, services } });
    expect(await readFile(`${path}.pre-scope-defaults.bak`, 'utf8')).toBe(original);
    prepare();
    expect(await readFile(path, 'utf8')).toBe(migrated);
    for (const scope of [{ ...legacy, enabled: false }, { ...legacy, enabled: true },
      { ...legacy, targets: [{ host: 'saved.example.test', schemes: ['https'], ports: [443], pathPrefixes: ['/'], allowPrivateAddresses: false }] },
      { ...legacy, exclusions: ['saved.example.test'] }, { ...legacy, networks: ['192.0.2.0/24'] }]) {
      const saved = JSON.stringify({ ...template, scope });
      await writeFile(path, saved); prepare();
      expect(await readFile(path, 'utf8')).toBe(saved);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
