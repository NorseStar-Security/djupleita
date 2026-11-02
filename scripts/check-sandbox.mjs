// Check worker preparation separately from CPU- and filesystem-heavy suites.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandbox } from '../packages/worker/lib/platform.js';

const root = await mkdtemp(join(tmpdir(), 'djupleita-sandbox-check-'));
try {
  const start = performance.now();
  const launch = await prepareSandbox({ executable: process.execPath, args: [], cwd: root },
    { writableRoots: [root] }, AbortSignal.timeout(10000));
  try { console.log(`Sandbox preparation passed in ${Math.round(performance.now() - start)}ms`); }
  finally { await launch.close(); }
} finally { await rm(root, { recursive: true, force: true }); }
