import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { privatePath, scanner } from './scan.mjs';

test('private runtime, environment and key files are rejected even without recognized secrets', () => {
  for (const path of ['.pentest/home/.credentials.yaml', 'nested/.env.production', '.dev.vars', '.credentials.yaml', 'cert.pem', 'artifacts/screenshot.jpg', '.security-tools/gitleaks']) assert.equal(privatePath(path), true, path);
  for (const path of ['.env.example', 'nested/.env.template', 'configs/engagement.example.json', 'docs/images/setup.jpg', 'packages/credentials/src/key.ts']) assert.equal(privatePath(path), false, path);
});
test('the pinned scanner blocks a generated synthetic credential', () => { scanner(); });
test('staged Git secrets are detected and deleting them later does not hide them from history', () => {
  const root = mkdtempSync(join(tmpdir(), 'djupleita-secret-test-'));
  const run = (cmd, args) => {
    const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.signal, null);
    assert.equal(result.error, undefined);
    return result;
  };
  try {
    assert.equal(run('git', ['init', '-q']).status, 0);
    assert.equal(run('git', ['config', 'user.name', 'Secret guard test']).status, 0);
    assert.equal(run('git', ['config', 'user.email', 'guard@example.test']).status, 0);
    const binary = process.env.GITLEAKS_BIN || resolve(import.meta.dirname, '../../.security-tools/gitleaks');
    const installed = spawnSync(binary, ['version']);
    const command = installed.error ? 'gitleaks' : binary;
    const flags = ['--config', resolve(import.meta.dirname, '../../.gitleaks.toml'), '--no-banner', '--redact=100', '--log-level', 'error'];
    writeFileSync(join(root, 'config.txt'), 'ordinary public configuration\n');
    assert.equal(run('git', ['add', 'config.txt']).status, 0);
    assert.equal(run(command, ['git', '--staged', ...flags]).status, 0);
    writeFileSync(join(root, 'config.txt'), 'token = "' + 'ghp_' + 'Q7m8r2B9t4N6v3K5z1P0w8L2x9C4d7F6h0J1' + '"\n');
    assert.equal(run('git', ['add', 'config.txt']).status, 0);
    assert.equal(run(command, ['git', '--staged', ...flags]).status, 1);
    assert.equal(run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic negative control']).status, 0);
    writeFileSync(join(root, 'config.txt'), 'ordinary public configuration\n');
    assert.equal(run('git', ['add', 'config.txt']).status, 0);
    assert.equal(run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Remove synthetic credential']).status, 0);
    assert.equal(run(command, ['git', '--log-opts=HEAD', ...flags]).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
