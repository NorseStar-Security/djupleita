import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { privatePath, scanner, imageText } from './scan.mjs';

const protectedName = 'BOPBOX'; // Public negative control; never a real customer name.
function scannerBinary() {
  const binary = process.env.GITLEAKS_BIN || resolve(import.meta.dirname, '../../.security-tools/gitleaks');
  return spawnSync(binary, ['version']).error ? 'gitleaks' : binary;
}
// Render a generated canary with a tiny bitmap font. No sensitive pixels are committed.
function syntheticImage(text) {
  const font = {
    "B": "eJzt0jEKACAMQ1Hvf2ldnOqvBCMiYsbylrap9edcSozqEgkOJTqAcaq6LgVHo9QN8DIXmeG0+83+sdoDYJaT+pJA4x8IHXfg6ZbbvK925+TD3ANeTe2LwMAB+nk4DQmM9l4=",
    "D": "eJzt1EEKwDAIRFHvf2m773zDNAmBBmcpLyIBzeycS0hcx5IcSXYKpVhAqCGs3r6r5TC207HFQcM1x99VuGj3SzcucLs1t3k/zL209jcC2af7YrD5+0eoc3EeIPcaSQ==",
    "O": "eJzt1EEOgCAMRNHe/9J148K0f2BQNxpmR3kJBCiZO68mzlhoTKPFZATLlIStzJCKUONFhBObnjN0wCqcnKnhcsXFdcDslhs9oj+6pfNz7+PZ/ZYZCU3X6mZ/2P3m9q/9H9R6KOb+VwiRNanUbGM738sBvkYNVg==",
    "P": "eJzt0rENACAMA0H2XzoM4AcskCjALqOjIHFVci9N4jqm6EAOnECduY7h6K3jCD7v1iN3f949Jj3Y75Wwgz4D4v/GxSXfpQO/A14F",
    "R": "eJzt0zEOwDAIQ9He/9Lpjv0TS1QMVRjRU1pwstatuXpMpc5RcALJVQgt6fLPBM7AGaftke+aBTb2h3mk+TbuC4x2QHUOVHXe8LwNrG2CNqDEAaSEzs5DzCh18fv9/H3I/tUpbLrNzbn1r3oBsNf/VQ==",
    "X": "eJzt0ksSgCAMA9De/9I446j8kia4cOHQnenTAlLKrq8qzsKxSEiKIM3ezcBuigkbJzM2dDjre9KFZE03Z7VvuZDshpJVKNgDTSeZ69z1mfut55LCC5i/Q+6lvwcUNs2la5pc+8BP7HPJ5CnHcJ6DJ4MQQfNdcy3sEMbcPatdP64D+9pZCg=="
};
  const scale = 3, margin = 48, glyphWidth = 40, glyphHeight = 56;
  const width = text.length * (glyphWidth + 4) * scale + 2 * margin, height = glyphHeight * scale + 2 * margin;
  const pixels = Buffer.alloc(width * height, 255);
  for (const [index, letter] of [...text].entries()) {
    const glyph = inflateSync(Buffer.from(font[letter], 'base64'));
    for (let y = 0; y < glyphHeight; y++) for (let x = 0; x < glyphWidth; x++) {
      if (glyph[y * glyphWidth + x] !== 0) continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) pixels[(margin + y * scale + dy) * width + margin + (index * (glyphWidth + 4) + x) * scale + dx] = 0;
    }
  }
  return Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]);
}

test('private runtime, environment and key files are rejected even without recognized secrets', () => {
  for (const path of ['.pentest/home/.credentials.yaml', 'nested/.env.production', '.dev.vars', '.credentials.yaml', 'cert.pem', 'artifacts/screenshot.jpg', '.security-tools/gitleaks']) assert.equal(privatePath(path), true, path);
  for (const path of ['.env.example', 'nested/.env.template', 'configs/engagement.example.json', 'docs/images/setup.jpg', 'packages/credentials/src/key.ts']) assert.equal(privatePath(path), false, path);
});
test('the pinned scanner blocks synthetic credentials and privately configured names', () => {
  const run = scanner({ references: [protectedName, 'PCX'] });
  run.close();
});
test('staged Git secrets are detected and deleting them later does not hide them from history', () => {
  const root = mkdtempSync(join(tmpdir(), 'djupleita-secret-test-'));
  const guard = scanner({ references: [protectedName, 'PCX'] });
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
    const command = scannerBinary();
    const flags = ['--config', guard.config, '--no-banner', '--redact=100', '--log-level', 'error', '--ignore-gitleaks-allow'];
    writeFileSync(join(root, 'config.txt'), 'ordinary public configuration\n');
    assert.equal(run('git', ['add', 'config.txt']).status, 0);
    assert.equal(run(command, ['git', '--staged', ...flags]).status, 0);
    for (const reference of [protectedName.toLowerCase(), protectedName.toUpperCase() + '.COM', protectedName.slice(0, 4) + '-' + protectedName.slice(4), 'PCX']) {
      writeFileSync(join(root, 'config.txt'), `target = "${reference}"\n`);
      assert.equal(run('git', ['add', 'config.txt']).status, 0);
      assert.equal(run(command, ['git', '--staged', ...flags]).status, 1);
    }
    writeFileSync(join(root, 'config.txt'), 'token = "' + 'ghp_' + 'Q7m8r2B9t4N6v3K5z1P0w8L2x9C4d7F6h0J1' + '"\n');
    assert.equal(run('git', ['add', 'config.txt']).status, 0);
    assert.equal(run(command, ['git', '--staged', ...flags]).status, 1);
    assert.equal(run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic negative control']).status, 0);
    writeFileSync(join(root, 'config.txt'), 'ordinary public configuration\n');
    assert.equal(run('git', ['add', 'config.txt']).status, 0);
    assert.equal(run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Remove synthetic credential']).status, 0);
    assert.equal(run(command, ['git', '--log-opts=HEAD', ...flags]).status, 1);
  } finally { guard.close(); rmSync(root, { recursive: true, force: true }); }
});

test('OCR scans staged bytes and historical images, without retaining generated canary pixels', () => {
  const root = mkdtempSync(join(tmpdir(), 'djupleita-image-test-'));
  const run = (cmd, args, env = process.env) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', env });
  try {
    for (const args of [['init', '-q'], ['config', 'user.name', 'Image guard test'], ['config', 'user.email', 'guard@example.test']]) assert.equal(run('git', args).status, 0);
    mkdirSync(join(root, 'scripts/security'), { recursive: true });
    mkdirSync(join(root, 'configs'));
    for (const path of ['scripts/security/scan.mjs', '.gitleaks.toml', 'configs/gitleaks.lock.json']) copyFileSync(resolve(import.meta.dirname, '../..', path), join(root, path));
    const image = syntheticImage(protectedName.toUpperCase());
    assert.ok(imageText(image).toUpperCase().includes(protectedName.toUpperCase()), 'OCR must read the generated protected name');
    const clean = syntheticImage('BOX');
    writeFileSync(join(root, 'screenshot.png'), clean);
    assert.equal(run('git', ['add', 'screenshot.png']).status, 0);
    const env = { ...process.env, GITLEAKS_BIN: scannerBinary(), DJUPLEITA_CONFIDENTIAL_REFERENCES: JSON.stringify([protectedName, 'PCX']) };
    const scan = (mode, revision) => run(process.execPath, ['scripts/security/scan.mjs', mode, ...(revision ? [revision] : [])], env);
    assert.equal(scan('staged').status, 0);
    const privateFilename = protectedName + '.txt';
    writeFileSync(join(root, privateFilename), 'ordinary text');
    assert.equal(run('git', ['add', privateFilename]).status, 0);
    assert.match(scan('staged').stderr, /filename contains a confidential/);
    assert.equal(run('git', ['rm', '-f', privateFilename]).status, 0);
    writeFileSync(join(root, 'screenshot.png'), Buffer.concat([clean, Buffer.from(protectedName)]));
    assert.equal(run('git', ['add', 'screenshot.png']).status, 0);
    assert.match(scan('staged').stderr, /confidential metadata/);
    writeFileSync(join(root, 'screenshot.png'), image);
    assert.equal(run('git', ['add', 'screenshot.png']).status, 0);
    writeFileSync(join(root, 'screenshot.png'), clean);
    const blocked = scan('staged');
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /screenshot contains a confidential/);
    assert.ok(!blocked.stderr.toLowerCase().includes(protectedName.toLowerCase()), 'do not print OCR text');
    assert.equal(run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Generated image negative control']).status, 0);
    assert.equal(run('git', ['rm', '-f', 'screenshot.png']).status, 0);
    assert.equal(run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Delete generated image']).status, 0);
    assert.equal(scan('history').status, 1);
    const missingBase = scan('range', 'f'.repeat(40) + '..HEAD');
    assert.equal(missingBase.status, 1);
    assert.match(missingBase.stdout, /scanning complete new history/);
    assert.match(missingBase.stderr, /screenshot contains a confidential/);
    const missing = run(process.execPath, ['scripts/security/scan.mjs', 'history'], { ...env, TESSERACT_BIN: join(root, 'missing-ocr') });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Screenshot scan failed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
