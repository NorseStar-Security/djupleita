import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('replays the shipped preset through native forking with assessment membership established before admission', () => {
  const output = execFileSync(process.execPath, ['--import', resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), 'tests/fixtures/replay.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 60000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ replayed: true, sourceUnchanged: true,
    membershipAtAdmission: true, ordinaryForkJoined: true, retainedLeads: 1, sourceRecorded: true, targetRequests: 0 });
}, 70000);
