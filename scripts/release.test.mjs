import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyProduction, copyRuntimeAssets, verifyRuntimeSkills, auditTree, runtimeFile } from './release.mjs';

test('relocated release includes every bundled assessment skill and the loader rejects missing assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-skills-'));
  try {
    const payload = join(root, 'app'); await mkdir(payload);
    await copyRuntimeAssets(resolve('.'), payload);
    // Use the built production loader with only its runtime dependency graph.
    // This test runs after pnpm build, just like the release pipeline.
    const plugin = resolve('packages/dsh-plugin');
    const dependencies = ['packages/contracts', 'packages/dsh-plugin'];
    const loader = join(payload, 'packages/dsh-plugin/lib'); await mkdir(loader, { recursive: true });
    for (const file of ['skills.js', 'tool-schema.js']) {
      await writeFile(join(loader, file), await readFile(join(plugin, 'lib', file)));
    }
    // Resolve these two imports without retaining any link to the source tree.
    const source = join(root, 'dependencies'); await mkdir(source);
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'skill-check', dependencies: { zod: '*', '@dsh-pentest/contracts': '*' } }));
    await mkdir(join(source, 'node_modules/@dsh-pentest'), { recursive: true });
    await symlink(resolve('packages/dsh-plugin/node_modules/zod'), join(source, 'node_modules/zod'));
    await symlink(resolve('packages/contracts'), join(source, 'node_modules/@dsh-pentest/contracts'));
    await copyProduction({ sourceRoot: resolve('.'), destination: payload, roots: [source], workspaceDirectories: dependencies.map(path => resolve(path)) });
    const relocated = join(root, 'relocated with spaces'); await rename(payload, relocated);
    verifyRuntimeSkills(relocated);
    for (const name of ['assessment', 'readiness', 'coverage', 'proof', 'report']) {
      assert.match(await readFile(join(relocated, 'skills', `djupleita-${name}`, 'SKILL.md'), 'utf8'), new RegExp(`name: djupleita-${name}\\n`));
    }
    await rm(join(relocated, 'skills/djupleita-assessment/SKILL.md'));
    assert.throws(() => verifyRuntimeSkills(relocated), /ENOENT|Command failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production graph preserves cycles and distinct versions after relocation, excluding private state and dev dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-graph-'));
  try {
    const source = join(root, 'source'), app = join(source, 'packages/app');
    const one = join(source, 'store/one'), two = join(source, 'store/two'), helper = join(source, 'store/helper'), addon = join(source, 'store/addon');
    for (const path of [app, one, two, helper, addon]) await mkdir(join(path, 'node_modules'), { recursive: true });
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies: { shared: '1', 'platform-addon': '*' }, devDependencies: { never: '*' } }));
    await mkdir(join(app, 'lib')); await writeFile(join(app, 'lib/index.js'), "import value from 'shared'; console.log(value);\n");
    await mkdir(join(app, '.pentest')); await writeFile(join(app, '.pentest/private.txt'), 'private-state');
    await writeFile(join(one, 'package.json'), JSON.stringify({ name: 'shared', version: '1', main: 'index.cjs', dependencies: { other: '2', helper: '*' } }));
    await writeFile(join(one, 'index.cjs'), "module.exports = 'one-' + require('other') + '-' + require('helper');\n");
    await writeFile(join(two, 'package.json'), JSON.stringify({ name: 'shared', version: '2', main: 'index.cjs', dependencies: { app: '*' } }));
    await writeFile(join(two, 'index.cjs'), "module.exports = 'two';\n");
    await writeFile(join(helper, 'package.json'), JSON.stringify({ name: 'helper', main: 'index.cjs' }));
    // The helper resolves a caller-owned optional native package, as native
    // addon loaders do. It has no direct dependency link of its own.
    await writeFile(join(helper, 'index.cjs'), "module.exports = require('platform-addon');\n");
    await writeFile(join(addon, 'package.json'), JSON.stringify({ name: 'platform-addon', main: 'index.cjs' }));
    await writeFile(join(addon, 'index.cjs'), "module.exports = 'addon';\n");
    await symlink(addon, join(app, 'node_modules/platform-addon'));
    await symlink(helper, join(one, 'node_modules/helper'));
    await symlink(one, join(app, 'node_modules/shared'));
    await symlink(two, join(one, 'node_modules/other'));
    await symlink(app, join(two, 'node_modules/app'));
    const destination = join(root, 'payload');
    const graph = await copyProduction({ sourceRoot: source, destination, roots: [app], workspaceDirectories: [app] });
    assert.deepEqual(graph.filter(item => item.name === 'shared').map(item => item.version), ['1', '2']);
    await assert.rejects(access(join(destination, 'packages/app/.pentest')));
    await rename(source, join(root, 'unavailable-source'));
    const relocated = join(root, 'relocated with spaces'); await rename(destination, relocated);
    await auditTree(relocated);
    assert.equal(execFileSync(process.execPath, [join(relocated, 'packages/app/lib/index.js')], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } }).trim(), 'one-two-addon');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('release audit rejects escaping links, broken links and private files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-audit-'));
  try {
    const payload = join(root, 'payload'); await mkdir(payload); await writeFile(join(root, 'outside'), 'outside');
    await symlink('../outside', join(payload, 'bad')); await assert.rejects(auditTree(payload), /Nonportable/);
    await rm(join(payload, 'bad')); await symlink('missing', join(payload, 'bad')); await assert.rejects(auditTree(payload));
    await rm(join(payload, 'bad')); await mkdir(join(payload, '.pentest')); await assert.rejects(auditTree(payload), /Private/);
    for (const file of ['.pentest/home/state', 'node_modules/foo', '.env', 'key.pem', 'lib/index.test.js']) assert.equal(runtimeFile(file), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('missing required dependency fails packaging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-missing-'));
  try {
    const source = join(root, 'source'); await mkdir(source);
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'broken', dependencies: { 'missing-fixture-dep': '*' } }));
    await assert.rejects(copyProduction({ sourceRoot: source, destination: join(root, 'payload'), roots: [source], workspaceDirectories: [source] }), /Missing runtime dependency/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a reviewed dependency finding never hides new credentials in the same file', async t => {
  const { scanRelease } = await import('./security/release-scan.mjs');
  const root = await mkdtemp(join(tmpdir(), 'release-scan-negative-'));
  const file = join(root, 'app/dep/main.js');
  const references = ['Quill Harbor Synthetic'];
  const dependencies = [{ name: 'synthetic-fixture', version: '1', path: 'dep' }];
  t.mock.method(console, 'error', () => {});
  try {
    await mkdir(join(root, 'app/dep'), { recursive: true });
    await writeFile(file, 'Organization.' + 'APIKeys = api_' + 'keys_1.APIKeys;\n');
    let reviewed;
    await assert.rejects(scanRelease(root, dependencies, { references, reviewed: [] }), error => {
      reviewed = error.findings;
      return reviewed?.length === 1 && reviewed[0].rule === 'generic-api-key';
    });
    await scanRelease(root, dependencies, { references, reviewed });
    await writeFile(file, 'Organization.' + 'APIKeys = api_' + 'keys_1.APIKeys;\nGITHUB_TOKEN=ghp_' + 'Q7m8r2B9t4N6v3K5z1P0w8L2x9C4d7F6h0J1\n');
    await assert.rejects(scanRelease(root, dependencies, { references, reviewed }), /unreviewed findings/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
