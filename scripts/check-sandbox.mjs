// Check worker preparation separately from CPU- and filesystem-heavy suites.
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandbox } from '../packages/worker/lib/platform.js';

const root = await mkdtemp(join(tmpdir(), 'djupleita-sandbox-check-'));
const original = fs.readdir, inventory = { directories: 0, entries: 0 };
fs.readdir = async (...args) => {
  const children = await original(...args);
  inventory.directories++; inventory.entries += children.length;
  return children;
};
syncBuiltinESMExports();
const start = performance.now();
try {
  const launch = await prepareSandbox({ executable: process.execPath, args: [], cwd: root },
    { writableRoots: [root] }, AbortSignal.timeout(10000));
  try { console.log(`Sandbox preparation passed: ${JSON.stringify({ preparationMs: Math.round(performance.now() - start), ...inventory })}`); }
  finally { await launch.close(); }
} catch (error) {
  console.log(JSON.stringify({ preparationMs: Math.round(performance.now() - start), ...inventory }));
  throw error;
} finally {
  fs.readdir = original; syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
}
