/** Materialize a local DSH profile using upstream bundles and these external plugins. */
import { globSync } from 'node:fs';
import { mkdir, readFile, writeFile, symlink, lstat, unlink, rename } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mergeProfilePatch } from './profile-patch.mjs';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const upstream = join(root, 'vendor/deepseek-harness');
export const home = join(root, '.pentest/home');
export const profile = join(home, 'profiles/pentest');
export async function linkPackage(directory, modules) {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  if (!manifest.name) return;
  const destination = join(modules, manifest.name);
  await mkdir(dirname(destination), { recursive: true });
  const previous = await lstat(destination).catch(() => undefined);
  if (previous && !previous.isSymbolicLink()) throw new Error(`Refusing to replace an installed package: ${destination}`);
  if (previous) await unlink(destination);
  await symlink(directory, destination, 'dir');
}
export async function prepareProfile(destination = profile) {
  const distribution = JSON.parse(await readFile(join(root, 'configs/distribution.json'), 'utf8'));
  const configPath = resolve(process.env.DSH_PENTEST_ENGAGEMENT ?? join(root, '.pentest/engagement.json'));
  const present = await lstat(configPath).catch(() => undefined);
  if (!present) {
    const template = JSON.parse(await readFile(join(root, 'configs/engagement.example.json'), 'utf8'));
    template.id = randomUUID(); await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await writeFile(configPath, `${JSON.stringify(template, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  const engagement = JSON.parse(await readFile(configPath, 'utf8'));
  const modules = join(destination, 'node_modules');
  await mkdir(modules, { recursive: true, mode: 0o700 });
  const workspaces = globSync(['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json'], { cwd: upstream });
  for (const file of workspaces) await linkPackage(join(upstream, dirname(file)), modules);
  for (const name of ['dsh-plugin', 'ui']) await linkPackage(join(root, 'packages', name), modules);
  for (const plugin of distribution.plugins) await linkPackage(join(root, 'packages', `plugin-${plugin.id}`), modules);
  const manifestPath = join(destination, 'package.json');
  const previous = JSON.parse(await readFile(manifestPath, 'utf8').catch(() => '{}'));
  const firstDistribution = previous.dsh?.profile?.distribution !== distribution.name;
  const bundles = previous.dsh?.profile?.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  // Remember introduced bundles separately from enabled bundles so upgrades add new
  // capabilities once without re-enabling anything the operator disabled.
  const knownBundles = previous.dsh?.profile?.distributionBundles ?? Object.keys(previous.dependencies ?? {}).filter(name => name.startsWith('@djupleita/plugin-'));
  const additions = distribution.plugins.map(plugin => plugin.name).filter(name => firstDistribution || !knownBundles.includes(name));
  const dependencies = { ...previous.dependencies,
    '@dsh-pentest/dsh-plugin': `link:${join(root, 'packages/dsh-plugin')}`,
    '@dsh-pentest/ui': `link:${join(root, 'packages/ui')}` };
  for (const plugin of distribution.plugins) {
    // Distribution bundles travel with the app; npm must not offer unrelated replacements.
    if (firstDistribution || additions.includes(plugin.name) || Object.hasOwn(dependencies, plugin.name)) {
      dependencies[plugin.name] = `link:${join(root, 'packages', `plugin-${plugin.id}`)}`;
    }
  }
  const manifest = { ...previous, name: 'djupleita-profile', version: distribution.version, private: true,
    dsh: { ...previous.dsh, profile: { ...previous.dsh?.profile, distribution: distribution.name,
      distributionBundles: [...new Set([...knownBundles, ...distribution.plugins.map(plugin => plugin.name)])],
      bundles: [...new Set([...bundles, ...additions])] } },
    dependencies };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const config = { engagement, root: join(root, '.pentest/engagements'), distributionRoot: root, keychainHelper: join(root, 'native/keychain-helper'),
    policy: { minimumConfidence: 0.8, deletionThreshold: 0.5, disruptionThreshold: 0.7, judgmentTimeoutMs: 15000, rules: [] } };
  try { config.plugins = JSON.parse(await readFile(join(root, '.pentest/tooling.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const preset = JSON.parse(await readFile(join(root, 'configs/pentest-preset.json'), 'utf8'));
  const patch = [
    '- id: agent-preset-registry\n  config:\n    default: pentest',
    '- id: desktop-product-telemetry\n  disabled: true',
    '- id: product-analytics\n  disabled: true',
    `- insert:\n    - id: pentest\n      name: '@dsh-pentest/dsh-plugin/core'\n      config: ${JSON.stringify(config)}\n    - id: pentest-ui\n      name: '@dsh-pentest/ui'\n    - id: preset-pentest\n      name: '@deepseek-ai/dsh-agent-preset'\n      config: ${JSON.stringify(preset)}`,
  ].join('\n');
  const patchPath = join(destination, 'cordis.patch.yml');
  const savedPatch = await readFile(patchPath, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '[]\n'; });
  const mergedPatch = mergeProfilePatch(savedPatch, `${patch}\n`);
  if (savedPatch !== mergedPatch) {
    await writeFile(`${patchPath}.pre-launch.bak`, savedPatch, { mode: 0o600 });
    const pendingPatch = `${patchPath}.${randomUUID()}.tmp`;
    await writeFile(pendingPatch, mergedPatch, { mode: 0o600 });
    await rename(pendingPatch, patchPath);
  }
  return { configPath, engagement, profile: destination };
}
