import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('exposes the shipped subagent and goal tools, runs six children and continues a goal with pentest policy enforced', () => {
  const output = execFileSync(process.execPath, ['tests/fixtures/orchestration.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 60000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ spawned: 6, forked: 1, followup: true,
    childPolicyEnforced: true, completeToolCatalog: true, goalRounds: 2, goalPhase: 'complete', targetRequests: 0 });
}, 70000);
