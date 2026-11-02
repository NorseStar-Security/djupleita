import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyProduction, auditTree, runtimeFile } from './release.mjs';

test('production graph preserves cycles and distinct versions after relocation, excluding private state and dev dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-graph-'));
  try {
    const source = join(root, 'source'), app = join(source, 'packages/app');
    const one = join(source, 'store/one'), two = join(source, 'store/two');
    for (const path of [app, one, two]) await mkdir(join(path, 'node_modules'), { recursive: true });
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', type: 'module', dependencies: { shared: '1' }, devDependencies: { never: '*' } }));
    await mkdir(join(app, 'lib')); await writeFile(join(app, 'lib/index.js'), "import value from 'shared'; console.log(value);\n");
    await mkdir(join(app, '.pentest')); await writeFile(join(app, '.pentest/private.txt'), 'private-state');
    await writeFile(join(one, 'package.json'), JSON.stringify({ name: 'shared', version: '1', main: 'index.cjs', dependencies: { other: '2' } }));
    await writeFile(join(one, 'index.cjs'), "module.exports = 'one-' + require('other');\n");
    await writeFile(join(two, 'package.json'), JSON.stringify({ name: 'shared', version: '2', main: 'index.cjs', dependencies: { app: '*' } }));
    await writeFile(join(two, 'index.cjs'), "module.exports = 'two';\n");
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
    assert.equal(execFileSync(process.execPath, [join(relocated, 'packages/app/lib/index.js')], { encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } }).trim(), 'one-two');
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
