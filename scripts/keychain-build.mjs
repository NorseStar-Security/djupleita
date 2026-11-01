import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('The credential helper requires macOS');
const root = resolve(import.meta.dirname, '..');
const result = spawnSync('/Library/Developer/CommandLineTools/usr/bin/swiftc', ['-module-cache-path', '/private/tmp/dsh-pentest-swift-cache',
  '-sdk', '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx15.0`,
  resolve(root, 'native/keychain-helper.swift'), '-o', resolve(root, 'native/keychain-helper')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
